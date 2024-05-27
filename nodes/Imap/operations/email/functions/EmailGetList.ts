import { FetchQueryObject, ImapFlow, Readable } from "imapflow";
import { IExecuteFunctions, INodeExecutionData } from "n8n-workflow";
import { IResourceOperationDef } from "../../../utils/CommonDefinitions";
import { getMailboxPathFromNodeParameter, parameterSelectMailbox } from "../../../utils/SearchFieldParameters";
import { emailSearchParameters, getEmailSearchParametersFromNode } from "../../../utils/EmailSearchParameters";


enum EmailParts {
  BodyStructure = 'bodyStructure',
  Flags = 'flags',
  Size = 'size',
  AttachmentsInfo = 'attachmentsInfo',
  TextContent = 'textContent',
  HtmlContent = 'htmlContent',
}

interface EmailPartInfo {
  partId: string;
  filename?: string;
  type: string;
  encoding: string;
  size: number;
  disposition?: string;
  parameters?: [string, string];
}

function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', reject);
  });
}

// get the parts info from the body structure
function getEmailPartsInfoRecursive(context: IExecuteFunctions, bodyStructure: any): EmailPartInfo[] {
  var partsInfo: EmailPartInfo[] = [];

  if (bodyStructure.childNodes) {
    for (const childNode of bodyStructure.childNodes) {
      // process only if "size" is present
      if ("size" in childNode) {
        var partInfo: EmailPartInfo = {
          partId: childNode.part,
          type: childNode.type,
          encoding: childNode.encoding,
          size: childNode.size,
        };
        if ("disposition" in childNode) {
          partInfo.disposition = childNode.disposition;
          if (childNode.disposition === 'attachment') {
            partInfo.filename = childNode.dispositionParameters?.filename;
          }
        }
        partsInfo.push(partInfo);
      }

      // check if there are child nodes
      if (childNode.childNodes) {
        // recurse
        partsInfo = partsInfo.concat(getEmailPartsInfoRecursive(context, childNode));
      }
    }
  }
  return partsInfo;
}

export const getEmailsListOperation: IResourceOperationDef = {
  operation: {
    name: 'Get Many',
    value: 'getEmailsList',
  },
  parameters: [
    {
      ...parameterSelectMailbox,
      description: 'Select the mailbox',
    },
    ...emailSearchParameters,
    //
    {
      displayName: 'Include Message Parts',
      name: 'includeParts',
      type: 'multiOptions',
      placeholder: 'Add Part',
      default: [],
      options: [
        {
          name: 'Text Content',
          value: EmailParts.TextContent,
        },
        {
          name: 'HTML Content',
          value: EmailParts.HtmlContent,
        },
        {
          name: 'Attachments Info',
          value: EmailParts.AttachmentsInfo,
        },
        {
          name: 'Flags',
          value: EmailParts.Flags,
        },
        {
          name: 'Size',
          value: EmailParts.Size,
        },
        {
          name: 'Body Structure',
          value: EmailParts.BodyStructure,
        },
      ],
    }
  ],
  async executeImapAction(context: IExecuteFunctions, itemIndex: number, client: ImapFlow): Promise<INodeExecutionData[] | null> {
    var returnData: INodeExecutionData[] = [];

    const mailboxPath = getMailboxPathFromNodeParameter(context, itemIndex);

    context.logger?.info(`Getting emails list from ${mailboxPath}`);

    await client.mailboxOpen(mailboxPath, { readOnly: true });

    var searchObject = getEmailSearchParametersFromNode(context, itemIndex);

    const includeParts = context.getNodeParameter('includeParts', itemIndex) as string[];
    var fetchQuery : FetchQueryObject = {
      uid: true,
      envelope: true,
    };

    if (includeParts.includes(EmailParts.BodyStructure)) {
      fetchQuery.bodyStructure = true;
    }
    if (includeParts.includes(EmailParts.Flags)) {
      fetchQuery.flags = true;
    }
    if (includeParts.includes(EmailParts.Size)) {
      fetchQuery.size = true;
    }
    // will parse the bodystructure to get the attachments info
    const includeAttachmentsInfo = includeParts.includes(EmailParts.AttachmentsInfo);
    if (includeAttachmentsInfo) {
      fetchQuery.bodyStructure = true;
    }
    // text Content and html Content
    const includeTextContent = includeParts.includes(EmailParts.TextContent);
    const includeHtmlContent = includeParts.includes(EmailParts.HtmlContent);
    if (includeTextContent || includeHtmlContent) {
      // will parse the bodystructure to get the parts IDs for text and html
      fetchQuery.bodyStructure = true;
    }

    // wait for all emails to be fetched before processing them
    // because we might need to fetch the body parts for each email,
    // and this will freeze the client if we do it in parallel
    const emailsList = [];
    for  await (let email of client.fetch(searchObject, fetchQuery)) {
      emailsList.push(email);
    }
    context.logger?.info(`Found ${emailsList.length} emails`);

    // process the emails
    for (const email of emailsList) {
      context.logger?.info(`  ${email.uid}`);
      var item_json = JSON.parse(JSON.stringify(email));

      const analyzeBodyStructure = includeAttachmentsInfo || includeTextContent || includeHtmlContent;

      var textPartId = null;
      var htmlPartId = null;
      var attachmentsInfo = [];


      if (analyzeBodyStructure) {
        // workaround: dispositionParameters is an object, but it is not typed as such
        const bodyStructure = email.bodyStructure as unknown as any;

        if (bodyStructure) {
          // check if multipart
          if (bodyStructure.childNodes) {
            // get the parts info (could be recursive)
            var partsInfo = getEmailPartsInfoRecursive(context, bodyStructure);
            for (const partInfo of partsInfo) {
              if (partInfo.disposition === 'attachment') {
                attachmentsInfo.push({
                  partId: partInfo.partId,
                  filename: partInfo.filename,
                  type: partInfo.type,
                  encoding: partInfo.encoding,
                  size: partInfo.size,
                });
              } else {
                if (partInfo.type === 'text/plain') {
                  textPartId = partInfo.partId;
                }
                if (partInfo.type === 'text/html') {
                  htmlPartId = partInfo.partId;
                }
              }
            }
          } else {
            // single part, use "TEXT" as part ID
            if (bodyStructure.type === 'text/plain') {
              textPartId = "TEXT";
            }
            if (bodyStructure.type === 'text/html') {
              htmlPartId = "TEXT";
            }
          }
        }
      }

      if (includeAttachmentsInfo) {
        item_json.attachmentsInfo = attachmentsInfo;
      }

      // fetch text and html content
      if (includeTextContent || includeHtmlContent) {
        if (includeTextContent && textPartId) {
          const textContent = await client.download(email.uid.toString(), textPartId, {
            uid: true,
          });
          item_json.textContent = await streamToString(textContent.content);
        }
        if (includeHtmlContent && htmlPartId) {
          //bodyPartsToRequest.push(htmlPartId);
          const htmlContent = await client.download(email.uid.toString(), htmlPartId, {
            uid: true,
          });
          item_json.htmlContent = await streamToString(htmlContent.content);
        }
      }

      returnData.push({
        json: item_json,
      });
    }

    return returnData;
  },
};
