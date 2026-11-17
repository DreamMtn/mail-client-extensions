import { UI_ICONS } from "./icons";
import { State } from "../models/state";
import { _t } from "../services/translation";
import { escapeHtml } from "../utils/html";

/**
 * Remove all cards and push the new one
 */
export function pushToRoot(card: Card) {
    return CardService.newNavigation().popToRoot().updateCard(card);
}

/**
 * Remove the last card and push a new one.
 */
export function updateCard(card: Card) {
    return CardService.newNavigation().updateCard(card);
}

/**
 * Push a new card on the stack.
 */
export function pushCard(card: Card) {
    return CardService.newNavigation().pushCard(card);
}

/**
 * Build a widget "Key / Value / Icon"
 *
 * If the icon if not a valid URL, take the icon from:
 * https://github.com/webdog/octicons-png
 */
export function createKeyValueWidget(
    label: string,
    content: string,
    icon: string = null,
    bottomLabel: string = null,
    button: Button = null,
    action: any = null,
    wrap: boolean = true,
    iconLabel: string = null,
    iconCropStyle: GoogleAppsScript.Card_Service.ImageCropType = CardService.ImageCropType.SQUARE,
) {
    const widget = CardService.newDecoratedText().setText(content).setWrapText(true);
    if (label && label.length) {
        widget.setTopLabel(escapeHtml(label));
    }

    if (bottomLabel) {
        widget.setBottomLabel(bottomLabel);
    }

    if (button) {
        widget.setButton(button);
    }
    if (action) {
        if (typeof action === "string") {
            widget.setOpenLink(CardService.newOpenLink().setUrl(action));
        } else {
            widget.setOnClickAction(action);
        }
    }

    if (icon && icon.length) {
        const isIconUrl =
            icon.indexOf("http://") === 0 || icon.indexOf("https://") === 0 || icon.indexOf("data:image/") === 0;
        if (!isIconUrl) {
            throw new Error("Invalid icon URL");
        }

        widget.setStartIcon(
            CardService.newIconImage()
                .setIconUrl(icon)
                .setImageCropType(iconCropStyle)
                .setAltText(escapeHtml(iconLabel || label)),
        );
    }

    widget.setWrapText(wrap);

    return widget;
}

/**
 * The state is serialized into the parameters of *every* action of a card, and
 * it carries the contact's picture and every open task of the customer. A card
 * listing 80 tasks therefore holds 80+ copies of a state listing those same 80
 * tasks, which makes the add-on slow to render and every click slow to send.
 *
 * Above this size, the state is stored once in the user cache and the actions
 * only carry its key. The cache keeps it for 6 hours (its maximum); a value is
 * limited to 100 KB, bigger states stay inline as before.
 */
const STATE_INLINE_MAX_SIZE = 2000;
const STATE_CACHE_MAX_SIZE = 90 * 1024;
const STATE_CACHE_TTL = 21600;

// States already put in the cache during this execution, serialized state -> key
const _cachedStateKeys: Map<string, string> = new Map();

function _stateParameters(stateJson: string): Record<string, string> {
    if (stateJson.length <= STATE_INLINE_MAX_SIZE || stateJson.length > STATE_CACHE_MAX_SIZE) {
        return { state: stateJson };
    }

    let stateKey = _cachedStateKeys.get(stateJson);
    if (!stateKey) {
        stateKey =
            "ODOO_STATE_" +
            Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, stateJson));
        try {
            CacheService.getUserCache().put(stateKey, stateJson, STATE_CACHE_TTL);
        } catch (error) {
            console.warn("Dream Mountain: could not cache the state: " + ((error && error.message) || error));
            return { state: stateJson };
        }
        _cachedStateKeys.set(stateJson, stateKey);
    }
    return { stateKey: stateKey };
}

function _handleActionCall(event) {
    const functionName = event.parameters.functionName;

    try {
        let stateJson = event.parameters.state;
        if (!stateJson && event.parameters.stateKey) {
            stateJson = CacheService.getUserCache().get(event.parameters.stateKey);
            if (!stateJson) {
                return notify(_t("This card is out of date, please open the email again."));
            }
        }

        const state = State.fromJson(stateJson);

        // The token giving access to the open email is only valid for a while.
        // The one saved in the state dates from when the card was first built,
        // so an email left open for some time could no longer be read when the
        // user finally clicked (e.g. "Create" a task), and only reloading Gmail
        // -- which builds a new card with a new token -- fixed it. Gmail sends
        // a fresh token with every action: use it.
        const freshToken = event.gmail && event.gmail.accessToken;
        if (freshToken) {
            state.email.accessToken = freshToken;
        }

        const parameters = JSON.parse(event.parameters.parameters);
        const inputs = event.formInputs;
        return eval(functionName)(state, parameters, inputs);
    } catch (error) {
        // Anything thrown from here is turned by Gmail into a card which only
        // says "Something went wrong when executing the add-on", replacing the
        // whole add-on and telling neither the user nor us what broke. Report
        // the reason instead and keep the current card on screen. The full
        // stack goes to the Apps Script executions log.
        const message = "" + ((error && error.message) || error);
        console.error("Dream Mountain: " + functionName + " failed: " + ((error && error.stack) || message));
        return notify(_t("Dream Mountain: %s", message));
    }
}

/**
 * Create an action which will call the given function and pass the state in arguments.
 *
 * This is necessary because event handlers can call only function and all arguments
 * must be strings. Therefor we serialized the state and other arguments to clean the code
 * and to be able to access to it in the event handlers.
 */
export function actionCall(state: State, functionName: string, parameters: any = {}) {
    return CardService.newAction()
        .setFunctionName(_handleActionCall.name)
        .setParameters({
            functionName: functionName,
            ..._stateParameters(state.toJson()),
            parameters: JSON.stringify(parameters),
        });
}

export function notify(message: string) {
    return CardService.newActionResponseBuilder()
        .setNotification(CardService.newNotification().setText(message))
        .build();
}

export function openUrl(url: string) {
    return CardService.newActionResponseBuilder().setOpenLink(CardService.newOpenLink().setUrl(url)).build();
}
