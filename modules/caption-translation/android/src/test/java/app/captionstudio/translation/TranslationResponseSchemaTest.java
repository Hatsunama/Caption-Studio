package app.captionstudio.translation;

import static org.junit.Assert.*;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.lang.reflect.InvocationTargetException;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class TranslationResponseSchemaTest {
  private static String schema(List<String> ids) throws Exception {
    try {
      return (String) Class.forName("app.captionstudio.translation.TranslationResponseSchema")
          .getDeclaredMethod("forIds", List.class).invoke(null, ids);
    } catch (InvocationTargetException failure) {
      if (failure.getCause() instanceof Exception) throw (Exception) failure.getCause();
      throw failure;
    }
  }

  @Test public void exactCountAndExpectedIdsConstrainActualResponses() throws Exception {
    JsonObject spec = JsonParser.parseString(schema(List.of("cue:1", "part-2._"))).getAsJsonObject();
    assertTrue(accepts(spec, "[{\"id\":\"cue:1\",\"text\":\"Hola\"},{\"id\":\"part-2._\",\"text\":\"Adios\"}]"));
    assertFalse(accepts(spec, "[]"));
    assertFalse(accepts(spec, "[{\"id\":\"cue:1\",\"text\":\"Hola\"}]"));
    assertFalse(accepts(spec, "[{\"id\":\"cue:1\",\"text\":\"Hola\"},{\"id\":\"wrong\",\"text\":\"Adios\"}]"));
    assertFalse(accepts(spec, "[{\"id\":\"cue:1\",\"text\":\"Hola\"},{\"id\":\"part-2._\",\"text\":\"Adios\"},{\"id\":\"cue:1\",\"text\":\"Extra\"}]"));
    assertEquals(JsonParser.parseString("[\"cue:1\",\"part-2._\"]"),
        spec.getAsJsonObject("items").getAsJsonObject("properties").getAsJsonObject("id").get("enum"));
  }

  @Test public void requiresNonemptyStringTextAndOnlyRequiredProperties() throws Exception {
    JsonObject spec = JsonParser.parseString(schema(List.of("c1"))).getAsJsonObject();
    for (String response : new String[] {
        "[{\"id\":\"c1\",\"text\":\"\"}]", "[{\"id\":\"c1\",\"text\":null}]",
        "[{\"id\":\"c1\",\"text\":7}]", "[{\"id\":7,\"text\":\"Hola\"}]",
        "[{\"id\":\"c1\"}]", "[{\"text\":\"Hola\"}]",
        "[{\"id\":\"c1\",\"text\":\"Hola\",\"extra\":true}]"
    }) assertFalse(response, accepts(spec, response));
    assertTrue(accepts(spec, "[{\"id\":\"c1\",\"text\":\"Hola\\nMundo\"}]"));
    assertEquals(JsonParser.parseString("[\"id\",\"text\"]"), spec.getAsJsonObject("items").get("required"));
  }

  @Test public void rejectsInvalidDuplicateAndEscapedTransportIdsWithoutEchoingThem() throws Exception {
    for (List<String> ids : Arrays.asList(null, List.<String>of(), Arrays.asList((String) null),
        List.of(""), List.of("c1", "c1"), List.of("x".repeat(65)), List.of("quote\"id"),
        List.of("slash\\id"), List.of("line\nid"), List.of("\u0000"), List.of("\u4f60\u597d"))) {
      IllegalArgumentException failure = assertThrows(IllegalArgumentException.class, () -> schema(ids));
      assertEquals("Expected nonempty unique transport IDs matching [A-Za-z0-9._:-]{1,64}", failure.getMessage());
    }
    JsonObject spec = JsonParser.parseString(schema(List.of("x".repeat(64)))).getAsJsonObject();
    assertEquals(1, spec.get("minItems").getAsInt());
    assertEquals(1, spec.get("maxItems").getAsInt());
  }

  // Interpret the generated schema's keywords against response data, never source code.
  private static boolean accepts(JsonObject spec, String response) {
    JsonElement value = JsonParser.parseString(response);
    if (!"array".equals(spec.get("type").getAsString()) || !value.isJsonArray()) return false;
    JsonArray array = value.getAsJsonArray();
    if (spec.has("minItems") && array.size() < spec.get("minItems").getAsInt()) return false;
    if (spec.has("maxItems") && array.size() > spec.get("maxItems").getAsInt()) return false;
    JsonObject itemSpec = spec.getAsJsonObject("items");
    if (!"object".equals(itemSpec.get("type").getAsString())) return false;
    JsonObject properties = itemSpec.getAsJsonObject("properties");
    for (JsonElement item : array) {
      if (!item.isJsonObject()) return false;
      JsonObject object = item.getAsJsonObject();
      for (JsonElement required : itemSpec.getAsJsonArray("required"))
        if (!object.has(required.getAsString())) return false;
      if (!itemSpec.get("additionalProperties").getAsBoolean())
        for (String key : object.keySet()) if (!properties.has(key)) return false;
      for (String key : properties.keySet()) {
        JsonElement field = object.get(key);
        JsonObject fieldSpec = properties.getAsJsonObject(key);
        if (!"string".equals(fieldSpec.get("type").getAsString()) || field == null
            || !field.isJsonPrimitive() || !field.getAsJsonPrimitive().isString()) return false;
        if (fieldSpec.has("minLength") && field.getAsString().codePointCount(0, field.getAsString().length())
            < fieldSpec.get("minLength").getAsInt()) return false;
        if (fieldSpec.has("enum") && !fieldSpec.getAsJsonArray("enum").contains(field)) return false;
      }
    }
    return true;
  }
}
