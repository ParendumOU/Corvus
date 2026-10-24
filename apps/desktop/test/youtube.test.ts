import { describe, expect, it } from "vitest";
import { chunkTranscript, formatTimestamp, parseJson3, parseTimestamp, youTubeVideoId } from "../src/shared/youtube";

describe("YouTube videos for Assist", () => {
  it("knows a watch address and its video", () => {
    expect(youTubeVideoId("https://www.youtube.com/watch?v=s_ycz6OD5fc&t=30")).toBe("s_ycz6OD5fc");
    expect(youTubeVideoId("https://m.youtube.com/shorts/abcDEF12345")).toBe("abcDEF12345");
    expect(youTubeVideoId("https://www.youtube.com/live/abcDEF12345?si=x")).toBe("abcDEF12345");
    expect(youTubeVideoId("https://www.youtube.com/results?search_query=x")).toBeNull();
    expect(youTubeVideoId("https://youtube.com.evil.example/watch?v=abcDEF12345")).toBeNull();
    expect(youTubeVideoId("not a url")).toBeNull();
  });

  it("writes and reads timestamps", () => {
    expect(formatTimestamp(75.9)).toBe("1:15");
    expect(formatTimestamp(3725)).toBe("1:02:05");
    expect(parseTimestamp("12:30")).toBe(750);
    expect(parseTimestamp(" 1:02:05 ")).toBe(3725);
    expect(parseTimestamp("Chapter 1")).toBeNull();
  });

  it("reads json3 captions", () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "Hello " }, { utf8: "there" }] },
        { tStartMs: 1500, segs: [{ utf8: "\n" }] },
        { tStartMs: 2500, segs: [{ utf8: "ravens   are smart" }] },
        { dDurationMs: 10 },
      ],
    });
    expect(parseJson3(raw)).toEqual([
      { start: 0, text: "Hello there" },
      { start: 2.5, text: "ravens are smart" },
    ]);
    expect(parseJson3("not json")).toEqual([]);
  });

  it("groups speech into timestamped stretches, longer for long videos", () => {
    const segs = Array.from({ length: 30 }, (_, i) => ({ start: i * 10, text: `s${i}` }));
    const chunks = chunkTranscript(segs);
    expect(chunks.map((c) => c.heading)).toEqual(["0:00", "1:00", "2:00", "3:00", "4:00"]);
    expect(chunks[0]!.text).toBe("s0 s1 s2 s3 s4 s5");
    const long = Array.from({ length: 2000 }, (_, i) => ({ start: i * 3, text: "x" }));
    expect(chunkTranscript(long, 60).length).toBeLessThanOrEqual(61);
  });
});
