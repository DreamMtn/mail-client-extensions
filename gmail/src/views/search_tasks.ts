import { createKeyValueWidget, actionCall, notify, pushCard, updateCard } from "./helpers";
import { UI_ICONS } from "./icons";
import { getOdooServerUrl } from "src/services/app_properties";
import { State } from "../models/state";
import { Task } from "../models/task";
import { logEmail } from "../services/log_email";
import { _t } from "../services/translation";
import { truncate } from "../utils/format";
import { escapeHtml } from "../utils/html";

/**
 * "Search tasks" view: find a task of the customer by name or by number and
 * log the email on it, for customers with too many open tasks to scroll
 * through on the contact card.
 */

const INCLUDE_CLOSED = "include_closed";
const ALL_CUSTOMERS = "all_customers";

function _readOptions(inputs: any): [string, boolean, boolean] {
    const queryInput = inputs && inputs.search_task_query;
    const query = ((queryInput && queryInput.length && queryInput[0]) || "").trim();
    const options: string[] = (inputs && inputs.search_task_options) || [];
    return [query, options.indexOf(INCLUDE_CLOSED) >= 0, options.indexOf(ALL_CUSTOMERS) >= 0];
}

/**
 * Run the search. "fromContactCard" is set when the search was started from
 * the contact card, which pushes the results card; refining the search from
 * the results card updates it in place.
 */
export function onSearchTasks(state: State, parameters: any, inputs: any) {
    const [query, includeClosed, allCustomers] = _readOptions(inputs);

    if (!query.length) {
        if (parameters.fromContactCard) {
            return notify(_t("Type a task name or number to search"));
        }
        state.searchedTasks = null;
        return updateCard(buildSearchTasksView(state, query, includeClosed, allCustomers));
    }

    const [tasks, error] = Task.searchTasks(query, state.partner.id, includeClosed, allCustomers);
    if (error.code) {
        return notify(error.message || _t("Could not search the tasks, please try again."));
    }

    state.searchedTasks = tasks;
    const card = buildSearchTasksView(state, query, includeClosed, allCustomers);
    return parameters.fromContactCard ? pushCard(card) : updateCard(card);
}

function onLogEmailOnSearchedTask(state: State, parameters: any) {
    const taskId = parameters.taskId;

    if (!State.checkLoggingState(state.email.messageId, "tasks", taskId)) {
        return notify(_t("Email already logged on the task"));
    }

    const error = logEmail(taskId, "project.task", state.email);
    if (error.code && error.code !== "attachments_size_exceeded") {
        return notify(_t("Could not log the email on the task, please try again."));
    }
    State.setLoggingState(state.email.messageId, "tasks", taskId);

    return updateCard(buildSearchTasksView(state, parameters.query, parameters.includeClosed, parameters.allCustomers));
}

function onSearchedTaskAlreadyLogged() {
    return notify(_t("Email already logged on the task"));
}

/**
 * Search box shared by the contact card and the results card.
 */
export function addSearchTasksInput(
    state: State,
    section: CardSection,
    query: string = "",
    fromContactCard: boolean = false,
) {
    const action = actionCall(state, onSearchTasks.name, { fromContactCard: fromContactCard });
    const input = CardService.newTextInput()
        .setFieldName("search_task_query")
        .setTitle(_t("Search tasks (name or number)"))
        .setValue(query || "");
    // Enter / leaving the field runs the search on the results card. On the
    // contact card it would push a new card each time the field loses focus,
    // so the button is the only trigger there.
    if (!fromContactCard) {
        input.setOnChangeAction(action);
    }
    section.addWidget(input);
    return action;
}

export function buildSearchTasksView(
    state: State,
    query: string,
    includeClosed: boolean = false,
    allCustomers: boolean = false,
) {
    const odooServerUrl = getOdooServerUrl();
    const cids = state.odooCompaniesParameter;
    const loggingState = State.getLoggingState(state.email.messageId);
    const tasks = state.searchedTasks || [];

    const searchSection = CardService.newCardSection().setHeader("<b>" + _t("Search tasks") + "</b>");
    const searchAction = addSearchTasksInput(state, searchSection, query);

    searchSection.addWidget(
        CardService.newSelectionInput()
            .setType(CardService.SelectionInputType.CHECK_BOX)
            .setFieldName("search_task_options")
            .addItem(_t("Include closed tasks"), INCLUDE_CLOSED, includeClosed)
            .addItem(_t("Search all customers"), ALL_CUSTOMERS, allCustomers)
            .setOnChangeAction(searchAction),
    );

    searchSection.addWidget(CardService.newTextButton().setText(_t("Search")).setOnClickAction(searchAction));

    const card = CardService.newCardBuilder().addSection(searchSection);
    // Before the first search there is nothing to show, and Gmail refuses an
    // empty section.
    if (!state.searchedTasks) {
        return card.build();
    }

    const resultsSection = CardService.newCardSection();
    if (!tasks.length) {
        resultsSection.addWidget(CardService.newTextParagraph().setText(_t("No task found.")));
    } else {
        resultsSection.setHeader("<b>" + _t("Results (%s)", tasks.length) + "</b>");
    }

    for (const task of tasks) {
        const alreadyLogged = loggingState["tasks"].indexOf(task.id) >= 0;
        const button = alreadyLogged
            ? CardService.newImageButton()
                  .setAltText(_t("Email already logged on the task"))
                  .setIconUrl(UI_ICONS.email_logged)
                  .setOnClickAction(actionCall(state, onSearchedTaskAlreadyLogged.name))
            : CardService.newImageButton()
                  .setAltText(_t("Log the email on the task"))
                  .setIconUrl(UI_ICONS.email_in_odoo)
                  .setOnClickAction(
                      actionCall(state, onLogEmailOnSearchedTask.name, {
                          taskId: task.id,
                          query: query,
                          includeClosed: includeClosed,
                          allCustomers: allCustomers,
                      }),
                  );

        const details = [allCustomers ? task.partnerName : null, task.stageName, task.isClosed ? _t("Closed") : null]
            .filter((value) => value)
            .join(" · ");

        resultsSection.addWidget(
            createKeyValueWidget(
                task.projectName,
                `#${task.id} ` + escapeHtml(truncate(task.name, 35)),
                null,
                details || null,
                button,
                odooServerUrl + `/web#id=${task.id}&model=project.task&view_type=form${cids}`,
            ),
        );
    }

    if (tasks.length >= 30) {
        resultsSection.addWidget(
            CardService.newTextParagraph().setText(
                "<font color='#777777'>" + _t("Only the first 30 tasks are shown, refine the search.") + "</font>",
            ),
        );
    }

    return card.addSection(resultsSection).build();
}
