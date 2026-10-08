package app.captionstudio.translation;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Domain response constraints built solely from validated transport IDs. */
final class TranslationResponseSchema {
  private static final Pattern TRANSPORT_ID = Pattern.compile("[A-Za-z0-9._:-]{1,64}");
  private static final String INVALID_IDS =
      "Expected nonempty unique transport IDs matching [A-Za-z0-9._:-]{1,64}";

  static String forIds(List<String> ids) {
    if (ids == null || ids.isEmpty()) throw new IllegalArgumentException(INVALID_IDS);
    Set<String> seen = new HashSet<>();
    JsonArray expectedIds = new JsonArray();
    for (String id : ids) {
      if (id == null || !TRANSPORT_ID.matcher(id).matches() || !seen.add(id)) {
        throw new IllegalArgumentException(INVALID_IDS);
      }
      expectedIds.add(id);
    }
    JsonObject id = new JsonObject();
    id.addProperty("type", "string");
    id.add("enum", expectedIds);
    JsonObject text = new JsonObject();
    text.addProperty("type", "string");
    text.addProperty("minLength", 1);
    JsonObject properties = new JsonObject();
    properties.add("id", id);
    properties.add("text", text);
    JsonArray required = new JsonArray();
    required.add("id");
    required.add("text");
    JsonObject item = new JsonObject();
    item.addProperty("type", "object");
    item.add("properties", properties);
    item.add("required", required);
    item.addProperty("additionalProperties", false);
    JsonObject schema = new JsonObject();
    schema.addProperty("type", "array");
    schema.addProperty("minItems", expectedIds.size());
    schema.addProperty("maxItems", expectedIds.size());
    schema.add("items", item);
    return schema.toString();
  }

  private TranslationResponseSchema() {}
}
