import { embedInlineImages } from "../utils/inline_images";
import { ErrorMessage } from "../models/error_message";

/**
 * Reading the body or the attachments of an email downloads the whole message
 * from Gmail (the raw MIME included, to resolve the inline images) and base 64
 * encodes it. Creating a task needs both twice -- once for the task itself and
 * once to log the email on it -- and a card callback is killed by Gmail after
 * 30 seconds, which showed up as "Something went wrong when executing the
 * add-on" on any email carrying pictures or attachments.
 *
 * Keep the result of that work for the duration of the callback. These are
 * module level (and not instance attributes) because the Email object is
 * serialized into the parameters of every card action: attributes holding a
 * full email body would be sent back and forth on each click.
 */
const _bodyCache: Record<string, string> = {};
const _attachmentsCache: Record<string, { attachments: string[][]; errorCode: string }> = {};

/**
 * Represent the current email open in the Gmail application.
 */
export class Email {
    accessToken: string;
    messageId: string;
    subject: string;

    contactEmail: string;
    contactFullEmail: string;
    contactName: string;

    // Raw FROM / TO / CC headers, used to find everyone taking part in the email.
    fromHeaders: string;
    toHeaders: string;
    ccHeaders: string;

    constructor(messageId: string = null, accessToken: string = null) {
        if (messageId) {
            const userEmail = Session.getEffectiveUser().getEmail().toLowerCase();

            this.accessToken = accessToken;

            this.messageId = messageId;
            const message = GmailApp.getMessageById(this.messageId);
            this.subject = message.getSubject();

            const fromHeaders = message.getFrom();
            const sent = fromHeaders.toLowerCase().indexOf(userEmail) >= 0;
            this.contactFullEmail = sent ? message.getTo() : message.getFrom();
            [this.contactName, this.contactEmail] = this._emailSplitTuple(this.contactFullEmail);

            this.fromHeaders = fromHeaders;
            this.toHeaders = message.getTo();
            this.ccHeaders = message.getCc();
        }
    }

    /**
     * Ask the email body only if the user asked for it (e.g. asked to log the email).
     */
    public get body() {
        if (typeof _bodyCache[this.messageId] === "string") {
            return _bodyCache[this.messageId];
        }

        GmailApp.setCurrentMessageAccessToken(this.accessToken);
        const message = GmailApp.getMessageById(this.messageId);
        // The images pasted in the email are only referenced by the body, they
        // must be embedded in it or Odoo will show broken images.
        const body = embedInlineImages(message, message.getBody());

        _bodyCache[this.messageId] = body;
        return body;
    }

    /**
     * Parse a full FROM header and return the name part and the email part.
     *
     * E.G.
     *     "BOB" <bob@example.com> => ["BOB", "bob@example.com"]
     *     bob@example.com         => ["bob@example.com", "bob@example.com"]
     *
     */
    _emailSplitTuple(fullEmail: string): [string, string] {
        const match = fullEmail.match(/(.*)<(.*)>/);
        fullEmail = fullEmail.replace("<", "").replace(">", "");

        if (!match) {
            return [fullEmail, fullEmail];
        }

        const [_, name, email] = match;

        if (!name || !email) {
            return [fullEmail, fullEmail];
        }

        const cleanedName = name.replace(/\"/g, "").trim();
        if (!cleanedName || !cleanedName.length) {
            return [fullEmail, fullEmail];
        }

        return [cleanedName, email];
    }

    /**
     * Unserialize the email object (reverse JSON.stringify).
     */
    static fromJson(values: any): Email {
        const email = new Email();

        email.accessToken = values.accessToken;
        email.messageId = values.messageId;
        email.subject = values.subject;

        email.contactEmail = values.contactEmail;
        email.contactFullEmail = values.contactFullEmail;
        email.contactName = values.contactName;

        email.fromHeaders = values.fromHeaders;
        email.toHeaders = values.toHeaders;
        email.ccHeaders = values.ccHeaders;

        return email;
    }

    /**
     * Return the full email address ("Name <name@example.com>") of everyone
     * taking part in the email: the sender and all the TO / CC recipients,
     * minus the mailbox owner (who does not need to follow their own records).
     */
    getRecipients(): string[] {
        const userEmail = Session.getEffectiveUser().getEmail().toLowerCase();
        const headers = [this.fromHeaders, this.toHeaders, this.ccHeaders];
        const recipients: string[] = [];
        const alreadyAdded: Record<string, boolean> = {};

        for (const header of headers) {
            for (const fullEmail of this._splitAddressList(header)) {
                const [_, address] = this._emailSplitTuple(fullEmail);
                const key = address.toLowerCase();

                if (key.indexOf("@") < 0 || key === userEmail || alreadyAdded[key]) {
                    continue;
                }

                alreadyAdded[key] = true;
                recipients.push(fullEmail);
            }
        }

        return recipients;
    }

    /**
     * Split a TO / CC header into its individual addresses.
     *
     * Commas are only separators outside of a quoted display name and outside
     * of the angle brackets, so that e.g.
     *     "Harris, Logan" <logan@example.com>, bob@example.com
     * is 2 addresses and not 3.
     */
    _splitAddressList(header: string): string[] {
        const addresses: string[] = [];
        let current = "";
        let inQuotes = false;
        let inAngleBrackets = false;

        for (const char of header || "") {
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (!inQuotes && char === "<") {
                inAngleBrackets = true;
            } else if (!inQuotes && char === ">") {
                inAngleBrackets = false;
            } else if (char === "," && !inQuotes && !inAngleBrackets) {
                addresses.push(current.trim());
                current = "";
                continue;
            }
            current += char;
        }
        addresses.push(current.trim());

        return addresses.filter((address) => address.length > 0);
    }

    /**
     * Return the list of the attachments in the email.
     * Done in a getter and not as a property because this object is serialized and
     * given to the event handler.
     *
     * Returns:
     *     - Null and "attachments_size_exceeded" error, if the total attachment size limit
     *       is exceeded so we do not keep big files in memory.
     *     - If no attachment, return an empty array and an empty error message.
     *     - Otherwise, the list of attachments base 64 encoded and an empty error message
     */
    getAttachments(): [string[][], ErrorMessage] {
        const cached = _attachmentsCache[this.messageId];
        if (cached) {
            // A fresh ErrorMessage: the callers set their own error on it.
            return [cached.attachments, new ErrorMessage(cached.errorCode)];
        }

        GmailApp.setCurrentMessageAccessToken(this.accessToken);
        const message = GmailApp.getMessageById(this.messageId);
        const gmailAttachments = message.getAttachments();
        const attachments: string[][] = [];

        // Base 64 inflates the attachments by a third, so the 50 MB limit of a
        // POST request is already reached at 37 MB of files. Stay well below
        // it: encoding and uploading more than a few MB does not fit in the 30
        // seconds Gmail gives a card callback either, and a callback killed
        // half way only shows "Something went wrong when executing the add-on".
        // Above this, the email is still logged, without its attachments.
        const MAXIMUM_ATTACHMENTS_SIZE = 10 * 1024 * 1024;

        let totalAttachmentsSize = 0;

        for (const gmailAttachment of gmailAttachments) {
            const bytesSize = gmailAttachment.getSize();
            totalAttachmentsSize += bytesSize;
            if (totalAttachmentsSize > MAXIMUM_ATTACHMENTS_SIZE) {
                _attachmentsCache[this.messageId] = { attachments: null, errorCode: "attachments_size_exceeded" };
                return [null, new ErrorMessage("attachments_size_exceeded")];
            }

            const name = gmailAttachment.getName();
            const content = Utilities.base64Encode(gmailAttachment.getBytes());

            attachments.push([name, content]);
        }

        _attachmentsCache[this.messageId] = { attachments: attachments, errorCode: null };
        return [attachments, new ErrorMessage(null)];
    }
}
