import { test } from "node:test";
import assert from "node:assert/strict";
import { addFacts, entityIndex, hasSeen, markSeen, newMemory, normalizeUrl, relatedFacts, similarity } from "./memory.ts";
import { extractText } from "./extract.ts";

test("URLs that are the same page normalize to the same key", () => {
  assert.equal(normalizeUrl("https://www.en.m.example.org/wiki/Osiris/?utm_source=x#History"), normalizeUrl("https://en.m.example.org/wiki/Osiris"));
  assert.notEqual(normalizeUrl("https://example.org/a"), normalizeUrl("https://example.org/b"));
  const mem = newMemory("rs-test-1", "q", "en");
  markSeen(mem, "https://www.britannica.com/topic/Osiris?utm_medium=feed");
  assert.ok(hasSeen(mem, "https://britannica.com/topic/Osiris"));
});

test("a reworded fact is recognised as a repeat and dropped", () => {
  assert.ok(similarity("Osiris was depicted with green skin symbolizing rebirth", "Osiris is often depicted with green skin, a symbol of rebirth") >= 0.55);
  const mem = newMemory("rs-test-2", "green deities", "en");
  const base = { sourceUrl: "https://a.example", sourceTitle: "A", wave: 1 };
  const first = addFacts(mem, [{ ...base, text: "Osiris was depicted with green skin symbolizing rebirth", entities: ["Osiris", "Egypt"] }]);
  const second = addFacts(mem, [
    { ...base, text: "Osiris is often depicted with green skin, a symbol of rebirth", entities: ["Osiris"] },
    { ...base, text: "The Green Man is a carved foliate face found in medieval European churches", entities: ["Green Man"] },
  ]);
  assert.equal(first.length, 1);
  assert.deepEqual(second.map((f) => f.entities[0]), ["Green Man"]);
  assert.equal(mem.facts.length, 2);
});

test("new facts connect to earlier ones through shared entities", () => {
  const mem = newMemory("rs-test-3", "green deities", "en");
  const base = { sourceUrl: "https://a.example", sourceTitle: "A", wave: 1 };
  addFacts(mem, [{ ...base, text: "Wadjet was a cobra goddess of Lower Egypt linked to the papyrus plant", entities: ["Wadjet", "Egypt"] }]);
  const fresh = addFacts(mem, [{ ...base, text: "In Egypt green pigment came from malachite and meant fertility", entities: ["Egypt", "malachite"] }]);
  assert.equal(relatedFacts(mem, fresh)[0].entities[0], "Wadjet");
  assert.equal(entityIndex(mem)[0].name, "Egypt");
});

test("page text keeps article paragraphs and drops chrome", () => {
  const html = `<html><head><script>var x=1</script></head><body><nav><p>Home About Contact us and more links here</p></nav>
    <p>Tara, known as the Green Tara in Tibetan Buddhism, is a female bodhisattva associated with compassion and action.</p>
    <p>Subscribe to our newsletter to get weekly updates on everything happening across the site.</p>
    <footer><p>Copyright 2026 all rights reserved by the publisher of this website.</p></footer></body></html>`;
  const text = extractText(html);
  assert.match(text, /Green Tara/);
  assert.doesNotMatch(text, /newsletter|Contact|rights reserved/);
});
