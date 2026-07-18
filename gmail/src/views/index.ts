import { buildPartnerView } from "./partner";
import { buildErrorView } from "./error";
import { buildCompanyView } from "./company";
import { buildLoginMainView } from "./login";
import { buildCardActionsView } from "./card_actions";
import { State } from "../models/state";
import { actionCall } from "./helpers";
import { getSalesEnabled } from "../services/app_properties";
import { _t } from "../services/translation";

export function buildView(state: State) {
    const card = CardService.newCardBuilder();

    if (state.error.code) {
        buildErrorView(state, card);
    }

    buildPartnerView(state, card);

    // Company Insights & enrichment are sales features, hidden unless the user
    // has opted in via the "Sales tools" toggle in the three-dots menu.
    if (getSalesEnabled()) {
        buildCompanyView(state, card);
    }

    buildCardActionsView(state, card);

    if (!State.isLogged) {
        card.setFixedFooter(
            CardService.newFixedFooter().setPrimaryButton(
                CardService.newTextButton()
                    .setText(_t("Login"))
                    .setBackgroundColor("#3B87C4")
                    .setOnClickAction(actionCall(state, buildLoginMainView.name)),
            ),
        );
    }

    return card.build();
}
