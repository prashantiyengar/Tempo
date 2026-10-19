// Built-in Google OAuth client IDs for ONE-CLICK sign-in.
//
// Leave these empty and every user sets up their own client (Settings → Google Calendar → Setup wizard).
// Fill them in once (see README "One-click sign-in for everyone") and every user of your build just clicks
// "Sign in with Google".
//
//   WEB_CLIENT_ID     OAuth client of type "Web application" whose authorized redirect URIs include the
//                     Chrome URI https://adheclccdehmdhjjfklageapjifndojo.chromiumapp.org/ and the Firefox URI
//                     shown in Settings. Used by Firefox, Edge, Brave… (and Chrome if CHROME_CLIENT_ID is empty).
//   CHROME_CLIENT_ID  OAuth client of type "Chrome extension" for item ID adheclccdehmdhjjfklageapjifndojo.
//                     Uses Chrome's built-in account picker and refreshes tokens automatically.
export const WEB_CLIENT_ID = '';
export const CHROME_CLIENT_ID = '';
// Microsoft app (client) ID for showing Outlook / Microsoft 365 calendars. Leave empty to let each user paste
// their own in Settings (Azure portal → App registrations → new "Single-page application" with the redirect URI
// shown in Settings and "Access tokens" enabled under Implicit grant).
export const OUTLOOK_CLIENT_ID = '';
