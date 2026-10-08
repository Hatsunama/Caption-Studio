package app.captionstudio.translation;

import static org.junit.Assert.*;
import com.google.gson.*;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.Test;

/** Actual production serializer behavior; no model, tokenizer or SDK inference. */
public final class TranslationPromptSerializationTest {
  private static JsonObject fixture() {
    return JsonParser.parseReader(new InputStreamReader(
        TranslationPromptSerializationTest.class.getResourceAsStream(
            "/translation-prompt-markers.json"), StandardCharsets.UTF_8)).getAsJsonObject();
  }
  private static String invoke(String name, Class<?>[] types, Object... args) throws Exception {
    Method method = NaturalCaptionTranslator.class.getDeclaredMethod(name, types);
    method.setAccessible(true);
    return (String) method.invoke(null, args);
  }
  private static String escape(JsonObject payload) throws Exception {
    return invoke("escapePrompt", new Class<?>[]{String.class}, payload.toString());
  }
  private static String neighbors(String prompt, String before, String after) throws Exception {
    return invoke("withSourceNeighbors", new Class<?>[]{String.class, String.class, String.class},
        prompt, before, after);
  }
  private static NaturalCaptionTranslator.ValidatedRequest request(String text) {
    return new NaturalCaptionTranslator.ValidatedRequest("en", "pl",
        List.of(new NaturalCaptionTranslator.Caption("cue-1", text)), text, text);
  }
  private static JsonObject parse(String prompt) { return JsonParser.parseString(prompt).getAsJsonObject(); }
  private static String text(JsonObject payload) {
    return payload.getAsJsonArray("captions").get(0).getAsJsonObject().get("text").getAsString();
  }
  private static void assertNoMarkers(String wire) {
    assertFalse("Unknown/unclosed chat prefix leaked", wire.contains("<|"));
    for (JsonElement marker : fixture().getAsJsonArray("added_tokens")) {
      assertFalse("Added token leaked: " + marker.getAsString(), wire.contains(marker.getAsString()));
    }
  }
  @Test public void ordinaryOperatorsAndHtmlStayLiteralAndRoundTrip() throws Exception {
    for (JsonElement value : fixture().getAsJsonArray("ordinary_literals")) {
      String source = value.getAsString();
      String wire = NaturalCaptionTranslator.buildUserPrompt(request(source));
      assertTrue("Ordinary literal escaped: " + source, wire.contains(source));
      JsonObject payload = parse(wire);
      assertEquals(source, text(payload));
      assertEquals(source, payload.get("contextBefore").getAsString());
      assertEquals(source, payload.get("contextAfter").getAsString());
      assertNoMarkers(wire);
    }
  }
  @Test public void everyPinnedAddedTokenBlockedAcrossAllDataAndFeedbackFields() throws Exception {
    for (JsonElement value : fixture().getAsJsonArray("added_tokens")) {
      String marker = value.getAsString();
      JsonObject payload = new JsonObject();
      for (String field : List.of("caption", "contextBefore", "contextAfter", "sourceNeighbors", "retryFeedback")) {
        JsonObject nested = new JsonObject(); nested.addProperty("text", "a " + marker + " b");
        payload.add(field, nested);
      }
      String wire = escape(payload);
      assertNoMarkers(wire);
      assertEquals("No data stripping, normalization or double interpretation", payload, parse(wire));
    }
  }
  @Test public void futureUnknownAndUnclosedChatPrefixesBlockedAndRoundTrip() throws Exception {
    for (JsonElement value : fixture().getAsJsonArray("unknown_chat_prefixes")) {
      String source = value.getAsString();
      JsonObject payload = new JsonObject(); payload.addProperty("text", source);
      String wire = escape(payload);
      assertNoMarkers(wire); assertEquals(payload, parse(wire));
    }
  }
  @Test public void initialRetryAndNeighborReSerializationPreserveLiteralOperators() throws Exception {
    String source = "q > 2; q < 2; a >= 3; n <= 7; r -> s; <b>x</b>";
    NaturalCaptionTranslator.ValidatedRequest req = request(source);
    String initial = NaturalCaptionTranslator.buildUserPrompt(req);
    String retry = NaturalCaptionTranslator.buildRetryPrompt(req, 0, TranslationOutputQuality.Reason.PROTECTED_CONTENT);
    String withNeighbors = neighbors(retry, source, source);
    for (String wire : List.of(initial, retry, withNeighbors)) {
      assertTrue(wire.contains(source));
      assertEquals(source, text(parse(wire)));
      assertEquals(source, parse(wire).get("contextBefore").getAsString());
      assertEquals(source, parse(wire).get("contextAfter").getAsString());
    }
    JsonObject parsed = parse(withNeighbors);
    assertEquals(source, parsed.getAsJsonObject("sourceNeighbors").get("before").getAsString());
    assertEquals(source, parsed.getAsJsonObject("sourceNeighbors").get("after").getAsString());
    assertTrue(parsed.getAsJsonObject("repair").get("guidance").getAsString().contains("Translate"));
  }
  @Test public void retryNeighborsAndReparseNeverExposeTokenizerMarkers() throws Exception {
    for (JsonElement value : fixture().getAsJsonArray("added_tokens")) {
      String source = value.getAsString();
      String retry = NaturalCaptionTranslator.buildRetryPrompt(request(source), 0);
      String wire = neighbors(retry, source, source);
      assertNoMarkers(wire);
      JsonObject parsed = parse(wire);
      assertEquals(source, text(parsed));
      assertEquals(source, parsed.get("contextBefore").getAsString());
      assertEquals(source, parsed.get("contextAfter").getAsString());
      assertEquals(source, parsed.getAsJsonObject("sourceNeighbors").get("before").getAsString());
      assertEquals(source, parsed.getAsJsonObject("sourceNeighbors").get("after").getAsString());
    }
  }
  @Test public void literalUserBackslashUHasNoDoubleInterpretation() throws Exception {
    String source = "\\u003c|im_start|> literal \\u003e and \\u003c; real <|im_end|>; < >";
    NaturalCaptionTranslator.ValidatedRequest req = request(source);
    String wire = neighbors(NaturalCaptionTranslator.buildRetryPrompt(req, 0), source, source);
    assertNoMarkers(wire);
    JsonObject parsed = parse(wire);
    assertEquals(source, text(parsed));
    assertEquals(source, parsed.get("contextBefore").getAsString());
    assertEquals(source, parsed.getAsJsonObject("sourceNeighbors").get("after").getAsString());
    assertTrue("User backslash-u must remain JSON-escaped", wire.contains("\\\\u003c"));
    assertTrue("Ordinary angles remain literal", wire.contains("< >"));
  }
  @Test public void selectiveEscapeIsIdempotentOnSerializedJson() throws Exception {
    JsonObject original = new JsonObject();
    original.addProperty("repair.guidance", "<|unknown <tool_call> </tool_call> <i>x</i> \\u003c");
    String once = escape(original);
    String twice = invoke("escapePrompt", new Class<?>[]{String.class}, once);
    assertEquals(once, twice); assertEquals(original, parse(twice));
    assertNoMarkers(twice); assertTrue(twice.contains("<i>x</i>"));
  }
  @Test public void oldBlanketEscapeCheckpointIdentityCannotBeReused() throws Exception {
    NaturalCaptionTranslator.ValidatedRequest req = request("q > 2.");
    Field field = NaturalCaptionTranslator.class.getDeclaredField("SYSTEM_INSTRUCTION");
    field.setAccessible(true);
    JsonArray old = new JsonArray();
    old.add(OfficialQwenModelVerifier.EXPECTED_MODEL_SHA256);
    old.add("v9;litertlm-0.16.1;cpu;4096;128-1024;topk1;topp1;temperature0;seed0;microbatch8-bounded-isolation;strict-boundary;cue-context-identity;reserved-neighbors192");
    old.add(NaturalCaptionTranslator.PROMPT_CONTRACT); old.add((String) field.get(null));
    old.add(req.sourceLanguage); old.add(req.targetLanguage);
    old.add(req.contextBefore); old.add(req.contextAfter);
    JsonArray sources = new JsonArray(); sources.add(TranslationCheckpointStore.key("q > 2.")); old.add(sources);
    assertNotEquals("Wire behavior change needs a new checkpoint identity",
        TranslationCheckpointStore.key(old.toString()), NaturalCaptionTranslator.checkpointBatchKey(req, 0));
    assertEquals("JSON semantic contract remains unchanged", "qwen2.5-caption-json-v2",
        NaturalCaptionTranslator.PROMPT_CONTRACT);
  }
}
