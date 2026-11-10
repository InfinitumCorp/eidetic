// © Infinitum Corporation®. All rights reserved.

import { describe, expect, it } from "vitest";
import { redactEideticEvent } from "./redact";

describe("redactEideticEvent", () => {
  it("drops user ids, URLs, and identity or match fields, keeping only a static page name", () => {
    const event = redactEideticEvent(
      {
        user_id: "helen-cho",
        userId: "dev-reviewer",
        user_properties: { email: "helen@example.com", name: "Helen Cho" },
        event_properties: {
          "[Amplitude] Page URL": "http://127.0.0.1:43111/?review=abc",
          "[Amplitude] Page Location": "http://127.0.0.1:43111/?review=abc",
          "[Amplitude] Page Path": "/reviews/abc",
          "[Amplitude] Page Title": "Jordan Blake",
          "[Amplitude] Page Query": "review=abc",
          referrer: "https://id.example/subject/avery",
          reviewId: "rev_123",
          candidate: "Avery Quinn",
          matchScore: 0.91,
          faceId: "tmpl_9",
          imageUrl: "https://store/face.png",
          language: "en",
        },
      },
      "review-desk",
    );

    expect(event.user_id).toBeUndefined();
    expect(event.userId).toBeUndefined();
    expect(event.user_properties).toEqual({});
    expect(event.event_properties).toEqual({
      language: "en",
      page_name: "review-desk",
      app: "eidetic",
    });
  });
});
