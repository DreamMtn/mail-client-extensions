import { postJsonRpc, lastCallErrorDetail, odooErrorCode } from "../utils/http";
import { ErrorMessage } from "../models/error_message";
import { URLS } from "../const";
import { getAccessToken } from "src/services/odoo_auth";

/**
 * Represent a "project.task" record.
 */
export class Task {
    id: number;
    name: string;
    projectName: string;
    // Only set on the results of "searchTasks"
    partnerName: string;
    stageName: string;
    isClosed: boolean;

    /**
     * Unserialize the task object (reverse JSON.stringify).
     */
    static fromJson(values: any): Task {
        const task = new Task();
        task.id = values.id;
        task.name = values.name;
        task.projectName = values.projectName;
        task.partnerName = values.partnerName;
        task.stageName = values.stageName;
        task.isClosed = values.isClosed;
        return task;
    }

    /**
     * Parse the dictionary return by the Odoo endpoint.
     */
    static fromOdooResponse(values: any): Task {
        const task = new Task();
        task.id = values.task_id;
        task.name = values.name;
        task.projectName = values.project_name;
        task.partnerName = values.partner_name;
        task.stageName = values.stage_name;
        task.isClosed = values.is_closed;
        return task;
    }

    /**
     * Make a RPC call to the Odoo database to create a task.
     *
     * Return the new task, or null and the reason why it could not be created
     * (shown to the user and written to the Apps Script executions log).
     */
    static createTask(partnerId: number, projectId: number, emailBody: string, emailSubject: string): [Task, string] {
        const url = PropertiesService.getUserProperties().getProperty("ODOO_SERVER_URL") + URLS.CREATE_TASK;
        const odooAccessToken = getAccessToken();

        const response = postJsonRpc(
            url,
            { email_subject: emailSubject, email_body: emailBody, project_id: projectId, partner_id: partnerId },
            { Authorization: "Bearer " + odooAccessToken },
            // Only retried when Odoo is known not to have processed the request,
            // so this can never create the task twice.
            { retryOnGatewayError: true },
        );

        const taskId = response ? response.task_id || null : null;

        if (!taskId) {
            const reason = lastCallErrorDetail() || "no task returned";
            console.error(
                "Dream Mountain: task/create failed for partner " +
                    partnerId +
                    ", project " +
                    projectId +
                    ": " +
                    reason,
            );
            return [null, reason];
        }

        return [
            Task.fromJson({
                id: taskId,
                name: response.name,
            }),
            null,
        ];
    }

    /**
     * Search the tasks the email can be logged on (endpoint of our
     * "dms_mail_plugin" Odoo module), by name or by task number.
     *
     * By default only the open tasks of the given contact's customer are
     * searched.
     */
    static searchTasks(
        query: string,
        partnerId: number,
        includeClosed: boolean = false,
        allCustomers: boolean = false,
    ): [Task[], ErrorMessage] {
        const url = PropertiesService.getUserProperties().getProperty("ODOO_SERVER_URL") + URLS.SEARCH_TASK;
        const odooAccessToken = getAccessToken();

        const response = postJsonRpc(
            url,
            {
                search_term: query,
                partner_id: partnerId,
                include_closed: includeClosed,
                all_customers: allCustomers,
            },
            { Authorization: "Bearer " + odooAccessToken },
            { retry: true },
        );

        // An empty list is a valid answer, so test for the failure explicitly.
        if (!Array.isArray(response)) {
            return [[], new ErrorMessage(odooErrorCode())];
        }

        return [response.map((values: any) => Task.fromOdooResponse(values)), new ErrorMessage()];
    }
}
