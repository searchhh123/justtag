import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, parseTag, postIdFromUrl, describeSplit } from "./parse.js";

const o = { bot: "JustTag", tagger: "you", poster: "Dexerto" };
const p = (t: string) => parseTag(t, o);

test("default is 50/50 with the poster", () => {
  assert.deepEqual(p("@Dexerto @JustTag").split, [
    { handle: "you", bps: 5000, role: "tagger" },
    { handle: "dexerto", bps: 5000, role: "poster" },
  ]);
});
test("own post defaults to 100%", () => {
  assert.deepEqual(parseTag("@JustTag", { ...o, poster: "you" }).split, [{ handle: "you", bps: 10000, role: "tagger" }]);
});
test("70/30", () => assert.deepEqual(p("@Dexerto @JustTag 70/30").split.map((s) => s.bps), [7000, 3000]));
test("all mine", () => assert.deepEqual(p("@JustTag all mine").split, [{ handle: "you", bps: 10000, role: "tagger" }]));
test("all to the poster", () => assert.deepEqual(p("@JustTag all to the poster").split, [{ handle: "dexerto", bps: 10000, role: "poster" }]));
test("50/50 @friend", () => {
  assert.deepEqual(p("@Dexerto @JustTag 50/50 @friend").split, [
    { handle: "you", bps: 5000, role: "tagger" },
    { handle: "friend", bps: 5000, role: "friend" },
  ]);
});
test("3-way with friends and leftover to poster", () => {
  assert.deepEqual(p("@JustTag 40/30/30 @a").split.map((s) => [s.handle, s.bps]), [["you", 4000], ["a", 3000], ["dexerto", 3000]]);
});
test("ticker + name override", () => {
  const r = p("@Dexerto @JustTag $jetdog Jet Ski Dog 70/30");
  assert.equal(r.ticker, "JETDOG");
  assert.equal(r.name, "Jet Ski Dog");
  assert.deepEqual(r.split.map((s) => s.bps), [7000, 3000]);
});
test("thread mentions before the bot do not get fees", () => {
  assert.equal(p("@Dexerto @someone @JustTag").split.length, 2);
});
test("odd ratios sum to 10000", () => {
  const r = p("@JustTag 1/2");
  assert.equal(r.split.reduce((a, b) => a + b.bps, 0), 10000);
});
test("post id from url", () => {
  assert.equal(postIdFromUrl("https://x.com/Dexerto/status/1991234567890123456?s=20"), "1991234567890123456");
  assert.equal(postIdFromUrl("https://twitter.com/a/status/123456"), "123456");
  assert.equal(postIdFromUrl("nope"), null);
});
test("describe", () => assert.equal(describeSplit([{ handle: "a", bps: 5000 }, { handle: "b", bps: 5000 }]), "50% @a, 50% @b"));
test("opt out / opt in commands", () => {
  assert.equal(parseCommand("@JustTag opt out"), "optout");
  assert.equal(parseCommand("@JustTag optout!"), "optout");
  assert.equal(parseCommand("@poster @JustTag opt-in"), "optin");
  assert.equal(parseCommand("@JustTag opt out of this nonsense 70/30"), null);
  assert.equal(parseCommand("@JustTag 50/50"), null);
});
