package app.captionstudio.translation;
import com.google.gson.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import org.junit.runner.*;
import org.junit.runner.notification.Failure;
public final class SerializationTestReceipt {
  public static void main(String[] args) throws Exception {
    Result result = JUnitCore.runClasses(TranslationPromptSerializationTest.class);
    JsonObject out = new JsonObject();
    out.addProperty("stage", args[0]); out.addProperty("tests", result.getRunCount());
    out.addProperty("successful", result.wasSuccessful());
    out.addProperty("source_behavior", "compiled actual production NaturalCaptionTranslator");
    int assertions=0, errors=0; JsonArray failures=new JsonArray();
    for (Failure f : result.getFailures()) {
      boolean assertion = f.getException() instanceof AssertionError;
      if (assertion) assertions++; else errors++;
      JsonObject row = new JsonObject();
      row.addProperty("test", f.getDescription().getMethodName());
      row.addProperty("type", f.getException().getClass().getName());
      row.addProperty("message", f.getMessage()); row.addProperty("trace", f.getTrace());
      failures.add(row);
    }
    out.addProperty("assertion_failures", assertions); out.addProperty("errors", errors);
    out.add("failures", failures);
    Files.write(Paths.get(args[1]), new GsonBuilder().setPrettyPrinting().create().toJson(out).getBytes(StandardCharsets.UTF_8));
    System.out.println(out);
    if (result.getRunCount()!=8 || errors!=0 || ("RED".equals(args[0]) ? assertions==0 : !result.wasSuccessful()))
      System.exit(1);
  }
}
