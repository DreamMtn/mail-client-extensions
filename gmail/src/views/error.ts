import { State } from "../models/state";
import { Partner } from "../models/partner";
import { createKeyValueWidget, actionCall } from "./helpers";
import { buildView } from "./index";
import { updateCard, pushToRoot } from "./helpers";
import { UI_ICONS } from "./icons";
import { resetAccessToken } from "../services/odoo_auth";
import { _t } from "../services/translation";
import { buildLoginMainView } from "./login";

function onCloseError(state: State) {
    state.error.code = null;
    return updateCard(buildView(state));
}

/**
 * Fetch the contact again after a call to the database failed.
 *
 * Those failures are usually transient (the database was restarting, the
 * request timed out,...) so retrying is what fixes them. Logging out and in
 * -- which the error message used to ask for -- does not, and costs a full
 * round trip through Odoo's authentication.
 */
function onRetry(state: State) {
    const [partner, odooUserCompanies, canCreatePartner, canCreateProject, error] = Partner.enrichPartner(
        state.email.contactEmail,
        state.email.contactName,
    );

    const newState = new State(
        partner,
        canCreatePartner,
        state.email,
        odooUserCompanies,
        null,
        null,
        canCreateProject,
        error,
    );

    return pushToRoot(buildView(newState));
}

function _addError(message: string, state: State, icon: string = null): CardSection {
    const errorSection = CardService.newCardSection();

    errorSection.addWidget(
        createKeyValueWidget(
            null,
            message,
            icon,
            null,
            CardService.newImageButton()
                .setAltText(_t("Close"))
                .setIconUrl(UI_ICONS.close)
                .setOnClickAction(actionCall(state, onCloseError.name)),
        ),
    );
    return errorSection;
}

export function buildErrorView(state: State, card: Card) {
    const error = state.error;

    const ignoredErrors = ["company_created", "company_updated"];
    if (ignoredErrors.indexOf(error.code) >= 0) {
        return;
    }

    if (error.code === "session_expired") {
        // Odoo rejected the stored token, so drop it: the rest of the card then
        // shows its "logged out" state instead of half working, and the user is
        // asked to log in once rather than on every transient failure.
        resetAccessToken();

        const errorSection = _addError(error.message, state);
        errorSection.addWidget(
            CardService.newTextButton()
                .setText(_t("Login"))
                .setOnClickAction(CardService.newAction().setFunctionName(buildLoginMainView.name)),
        );
        card.addSection(errorSection);
    } else if (error.code === "http_error_odoo") {
        const errorSection = _addError(error.message, state);
        errorSection.addWidget(
            CardService.newTextButton().setText(_t("Retry")).setOnClickAction(actionCall(state, onRetry.name)),
        );
        card.addSection(errorSection);
    } else if (error.code === "insufficient_credit") {
        const errorSection = _addError(error.message, state);
        errorSection.addWidget(
            CardService.newTextButton()
                .setText(_t("Buy new credits"))
                .setOpenLink(CardService.newOpenLink().setUrl(error.information)),
        );
        card.addSection(errorSection);
    } else if (error.code === "missing_data") {
        card.addSection(_addError(error.message, state));
    } else {
        let errors = [error.message, error.information].filter((x) => x);
        const errorMessage = errors.join("\n");
        card.addSection(_addError(errorMessage, state));
    }
}
