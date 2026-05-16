// Public surface for the Google adapter. Modules:
//   - oauth.ts: runOAuthLogin, persistGoogleCredentials, DEFAULT_SCOPES
//   - client.ts: makeOAuth2Client, credentialsFromEnv
//   - gmail.ts: searchMessages, sendMessage, wasSubjectSentRecently, buildRfc822Message
//   - calendar.ts: listUpcoming, createEvent

export {
  runOAuthLogin,
  persistGoogleCredentials,
  captureCallbackCode,
  DEFAULT_SCOPES,
  type OAuthLoginOptions,
  type OAuthLoginResult,
} from "./oauth.js";

export {
  makeOAuth2Client,
  credentialsFromEnv,
  type GoogleCredentials,
} from "./client.js";

export {
  searchMessages,
  sendMessage,
  wasSubjectSentRecently,
  buildRfc822Message,
  type GmailMessage,
  type SendMessageOptions,
} from "./gmail.js";

export {
  listUpcoming,
  createEvent,
  type CalendarEvent,
  type ListUpcomingOptions,
  type CreateEventOptions,
} from "./calendar.js";
