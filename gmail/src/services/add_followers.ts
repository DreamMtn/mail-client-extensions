import { postJsonRpc } from "../utils/http";
import { URLS } from "../const";
import { Email } from "../models/email";
import { getAccessToken } from "./odoo_auth";

/**
 * Subscribe everyone taking part in the email (sender, TO and CC recipients)
 * to the given record, so that a task created from an email keeps all of its
 * original participants in the loop.
 *
 * Best effort: the endpoint comes from our "dms_mail_plugin" module, so on a
 * database where it is not installed the call simply returns nothing and the
 * task is created without the extra followers.
 *
 * Returns the number of partners added as followers.
 */
export function addFollowers(recordId: number, recordModel: string, email: Email): number {
    const recipients = email.getRecipients();

    if (!recipients.length) {
        return 0;
    }

    const odooAccessToken = getAccessToken();
    const url = PropertiesService.getUserProperties().getProperty("ODOO_SERVER_URL") + URLS.ADD_FOLLOWERS;

    const response = postJsonRpc(
        url,
        { model: recordModel, res_id: recordId, emails: recipients },
        { Authorization: "Bearer " + odooAccessToken },
    );

    return (response && response.followers_added) || 0;
}
