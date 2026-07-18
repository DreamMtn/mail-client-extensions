export function getOdooServerUrl() {
    return PropertiesService.getUserProperties().getProperty("ODOO_SERVER_URL");
}
export function setOdooServerUrl(url: string) {
    PropertiesService.getUserProperties().setProperty("ODOO_SERVER_URL", url);
}

/**
 * Per-user "Sales tools" preference.
 *
 * When disabled (the default), the add-on only shows the project-management
 * features (contact match + Tasks). When enabled, the sales features are shown
 * too: Opportunities, Company Insights and enrichment.
 *
 * Stored in the user properties so each team member sets it once and it sticks
 * across emails and sessions (like the Odoo server URL above).
 */
export function getSalesEnabled(): boolean {
    return PropertiesService.getUserProperties().getProperty("DMS_SALES_ENABLED") === "1";
}
export function setSalesEnabled(enabled: boolean) {
    PropertiesService.getUserProperties().setProperty("DMS_SALES_ENABLED", enabled ? "1" : "0");
}
