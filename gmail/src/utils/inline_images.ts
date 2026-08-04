/**
 * Images pasted inside an email are not part of its HTML body: the body only
 * references the MIME part holding them, by Content-ID (`<img src="cid:ii_x">`).
 * Odoo has no way to resolve such a reference, so those images end up as broken
 * placeholders in the task / lead description and in the chatter.
 *
 * Replace every `cid:` reference by a base64 data URI so that the images travel
 * with the body itself.
 */

// Keep the body small enough for the POST request (and for the Odoo record).
// Bigger images keep their `cid:` reference, but are still sent as attachments.
const MAXIMUM_INLINE_IMAGE_SIZE = 2 * 1024 * 1024;
const MAXIMUM_INLINE_IMAGES_SIZE = 5 * 1024 * 1024;

// Matches `src="cid:ii_x"`, `src='cid:ii_x'` and `src=cid:ii_x`.
// Built on demand because a global regex keeps its `lastIndex` between calls.
const CID_SOURCE_PATTERN = "src\\s*=\\s*([\"']?)cid:([^\"'\\s>]+)\\1";

interface MimeImagePart {
    cid: string;
    name: string;
    mimeType: string;
}

/**
 * Return the Content-ID, the file name and the mime type of every image part of
 * the raw MIME message, in the order in which they appear.
 *
 * Returns an empty list when the raw message can not be read, which makes the
 * caller fall back on matching the images by position.
 */
function _parseImageParts(message: GoogleAppsScript.Gmail.GmailMessage): MimeImagePart[] {
    let rawContent: string;
    try {
        rawContent = message.getRawContent();
    } catch (error) {
        return [];
    }

    const imageParts: MimeImagePart[] = [];

    // The headers of a MIME part end on the first empty line, so splitting the
    // message on empty lines isolates them (the encoded bodies which follow
    // never contain one).
    for (let block of rawContent.split(/\r?\n\r?\n/)) {
        if (!/^content-id\s*:/im.test(block)) {
            continue;
        }

        // Unfold the headers which are written on more than one line.
        block = block.replace(/\r?\n[ \t]+/g, " ");

        const cid = block.match(/^content-id\s*:\s*<?([^>\r\n]+)>?/im);
        const mimeType = block.match(/^content-type\s*:\s*([^;\s]+)/im);
        const name = block.match(/\b(?:file)?name\s*=\s*"?([^";\r\n]+)"?/i);

        if (cid && name && mimeType && mimeType[1].toLowerCase().indexOf("image/") === 0) {
            imageParts.push({
                cid: cid[1].trim(),
                name: name[1].trim(),
                mimeType: mimeType[1].toLowerCase(),
            });
        }
    }

    return imageParts;
}

/**
 * Return the Content-IDs referenced by the body, in the order they appear.
 */
function _parseBodyCids(body: string): string[] {
    const regex = new RegExp(CID_SOURCE_PATTERN, "gi");
    const cids: string[] = [];
    const alreadyFound: Record<string, boolean> = {};

    let match = regex.exec(body);
    while (match) {
        const cid = match[2].trim();
        if (!alreadyFound[cid]) {
            alreadyFound[cid] = true;
            cids.push(cid);
        }
        match = regex.exec(body);
    }

    return cids;
}

/**
 * Build the `Content-ID -> data URI` map of the images of the email.
 */
function _buildDataUrls(message: GoogleAppsScript.Gmail.GmailMessage, body: string): Record<string, string> {
    const dataUrls: Record<string, string> = {};
    let totalImagesSize = 0;

    const addDataUrl = function (cid: string, attachment: GoogleAppsScript.Gmail.GmailAttachment, mimeType: string) {
        const bytesSize = attachment.getSize();
        if (bytesSize > MAXIMUM_INLINE_IMAGE_SIZE || totalImagesSize + bytesSize > MAXIMUM_INLINE_IMAGES_SIZE) {
            return;
        }
        totalImagesSize += bytesSize;
        dataUrls[cid] = "data:" + mimeType + ";base64," + Utilities.base64Encode(attachment.getBytes());
    };

    // Preferred way: the raw MIME tells us the Content-ID of each part, so we
    // know exactly which attachment a `cid:` reference points to. The
    // Content-ID is not exposed on the attachments themselves, so pair them
    // with the MIME parts by file name -- an attachment can only be used once,
    // which keeps the order right when the email contains several "image.png".
    const imageParts = _parseImageParts(message);
    if (imageParts.length) {
        const attachments = message.getAttachments();
        const usedAttachments: boolean[] = [];

        for (const imagePart of imageParts) {
            for (let index = 0; index < attachments.length; ++index) {
                if (usedAttachments[index] || attachments[index].getName() !== imagePart.name) {
                    continue;
                }
                usedAttachments[index] = true;
                addDataUrl(imagePart.cid, attachments[index], imagePart.mimeType);
                break;
            }
        }

        return dataUrls;
    }

    // Fallback when the raw message can not be read: the inline images are
    // returned in the order of the MIME parts, which is the order in which the
    // body references them. Only trust it when both lists have the same length,
    // so that we never show an image in place of an other one.
    const cids = _parseBodyCids(body);
    const inlineImages = message.getAttachments({ includeInlineImages: true, includeAttachments: false });

    if (cids.length === inlineImages.length) {
        for (let index = 0; index < cids.length; ++index) {
            addDataUrl(cids[index], inlineImages[index], inlineImages[index].getContentType());
        }
    }

    return dataUrls;
}

/**
 * Replace the `cid:` image references of the given email body by data URIs.
 */
export function embedInlineImages(message: GoogleAppsScript.Gmail.GmailMessage, body: string): string {
    if (!body || body.indexOf("cid:") < 0) {
        return body;
    }

    const dataUrls = _buildDataUrls(message, body);

    return body.replace(new RegExp(CID_SOURCE_PATTERN, "gi"), function (match, quote, cid) {
        const dataUrl = dataUrls[cid.trim()];
        return dataUrl ? "src=" + quote + dataUrl + quote : match;
    });
}
