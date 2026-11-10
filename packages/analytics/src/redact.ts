// © Infinitum Corporation®. All rights reserved.

/**
 * Strip anything that could identify a person, case, image, or match
 * from an Amplitude event. Page views keep only a static desk name.
 */
const URL_OR_PAGE_KEY = /url|path|location|query|referrer|href|domain|search|title/i;
const SENSITIVE_KEY =
  /face|image|photo|picture|match|identit|subject|candidat|biometric|template|embedding|email|phone|ssn|name|user_?id|actor|token|review_?id|session_token|display_name/i;

function clearRecord(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) delete record[key];
}

export function redactEideticEvent<T>(event: T, pageName: string): T {
  const e = event as T & {
    user_id?: unknown;
    userId?: unknown;
    user_properties?: unknown;
    userProperties?: unknown;
    event_properties?: Record<string, unknown>;
    eventProperties?: Record<string, unknown>;
  };
  delete e.user_id;
  delete e.userId;
  clearRecord(e.user_properties);
  clearRecord(e.userProperties);

  const source = e.event_properties ?? e.eventProperties ?? {};
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (URL_OR_PAGE_KEY.test(key) || SENSITIVE_KEY.test(key)) continue;
    props[key] = value;
  }
  props.page_name = pageName;
  props.app = "eidetic";
  e.event_properties = props;
  e.eventProperties = props;
  return event;
}
