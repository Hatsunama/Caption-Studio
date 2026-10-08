package app.captionstudio.verification.sharereceiver;

import java.nio.charset.StandardCharsets;

public final class SubtitleExportTest {
    private static int passed, failed;
    private static final String HEADER = "[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\n"
        + "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
    private static String dialogue(String start, String end, String text) {
        return "Dialogue: 0," + start + "," + end + ",Default,,0,0,0,," + text + "\n";
    }
    private static Validator.Result inspect(String input) {
        byte[] bytes = input.getBytes(StandardCharsets.UTF_8);
        return Validator.inspect(bytes, bytes.length);
    }
    private static void check(String name, boolean ok) {
        System.out.println((ok ? "PASS " : "FAIL ") + name);
        if (ok) passed++; else failed++;
    }
    private static void metadata(String name, String text, String format, int count, long first, long maximum) {
        Validator.Result result = inspect(text);
        String evidence = result.evidence();
        check(name, result.error.equals("NONE") && result.cues == count
            && evidence.contains("Format: " + format + "\n")
            && evidence.contains("First start ms: " + first + "\n")
            && evidence.contains("Maximum end ms: " + maximum + "\n")
            && evidence.contains("Bytes: " + result.bytes + "\n")
            && evidence.contains("SHA256: " + result.sha256 + "\n"));
    }
    private static void reject(String name, String text, String error) {
        check(name, inspect(text).error.equals(error));
    }
    public static void main(String[] args) {
        metadata("ASS fractional centiseconds and text commas",
            HEADER + dialogue("0:00:01.23", "0:00:02.34", "Locally authored, one"),
            "ASS", 1, 1230, 2340);
        metadata("ASS independently timed overlap and maximum not last",
            HEADER + dialogue("0:00:01.23", "0:00:05.67", "Local primary")
            + dialogue("0:00:00.99", "0:00:02.34", "Local translation"),
            "ASS", 2, 1230, 5670);
        metadata("SRT independently timed overlap and millisecond precision",
            "1\n00:00:01,237 --> 00:00:05,678\nLocal primary\n\n"
            + "2\n00:00:00,999 --> 00:00:02,345\nLocal translation\n",
            "SRT", 2, 1237, 5678);
        metadata("ASS BOM CRLF and escaped multiline",
            ("\ufeff" + HEADER + dialogue("1:02:03.04", "1:02:03.99", "Local\\Ntwo"))
                .replace("\n", "\r\n"), "ASS", 1, 3723040, 3723990);
        metadata("ASS declared time column order",
            "[Events]\nFormat: Layer, End, Start, Text\nDialogue: 0,0:00:02.34,0:00:01.23,Local\n",
            "ASS", 1, 1230, 2340);
        metadata("ASS comment event excluded from cue metadata",
            HEADER + "Comment: 0,0:00:00.00,0:59:59.99,Default,,0,0,0,,Local comment\n"
            + dialogue("0:00:01.23", "0:00:02.34", "Local"), "ASS", 1, 1230, 2340);
        metadata("ASS maximum bounded hour value fits long",
            HEADER + dialogue("999999999:59:58.99", "999999999:59:59.99", "Local"),
            "ASS", 1, 3599999999998990L, 3599999999999990L);
        reject("ASS minute bound", HEADER + dialogue("0:60:00.00", "1:01:00.00", "Local"), "TIMESTAMP_SYNTAX");
        reject("ASS second bound", HEADER + dialogue("0:00:60.00", "0:01:01.00", "Local"), "TIMESTAMP_SYNTAX");
        reject("ASS exactly two fractional digits", HEADER + dialogue("0:00:01.123", "0:00:02.34", "Local"), "TIMESTAMP_SYNTAX");
        reject("ASS missing fractional digits", HEADER + dialogue("0:00:01", "0:00:02.34", "Local"), "TIMESTAMP_SYNTAX");
        reject("ASS hour bound", HEADER + dialogue("1000000000:00:01.23", "1000000000:00:02.34", "Local"), "TIMESTAMP_SYNTAX");
        reject("ASS reversed timing", HEADER + dialogue("0:00:02.34", "0:00:01.23", "Local"), "TIMESTAMP_ORDER");
        reject("ASS zero duration", HEADER + dialogue("0:00:01.23", "0:00:01.23", "Local"), "TIMESTAMP_ORDER");
        reject("ASS missing Format", "[Events]\n" + dialogue("0:00:01.23", "0:00:02.34", "Local"), "ASS_FORMAT");
        reject("ASS duplicate timing columns", "[Events]\nFormat: Start, Start, End, Text\nDialogue: 0:00:01.23,0:00:01.23,0:00:02.34,Local\n", "ASS_FORMAT");
        reject("ASS Text must be final column", "[Events]\nFormat: Text, Start, End\nDialogue: Local,0:00:01.23,0:00:02.34\n", "ASS_FORMAT");
        reject("ASS missing event fields", HEADER + "Dialogue: 0,0:00:01.23\n", "ASS_EVENT_SYNTAX");
        reject("ASS empty text", HEADER + dialogue("0:00:01.23", "0:00:02.34", "  "), "EMPTY_CUE");
        reject("ASS no Dialogue cues", HEADER, "EMPTY_CUE");
        byte[] invalid = {(byte) 0xc3, (byte) 0x28};
        check("invalid UTF8 retained", Validator.inspect(invalid, invalid.length).error.equals("UTF8"));
        byte[] oversized = new byte[Validator.MAX_BYTES + 1];
        check("oversize rejection retained", Validator.inspect(oversized, oversized.length).error.equals("SIZE"));
        check("invalid timeline unavailable", inspect(HEADER + dialogue("bad", "0:00:02.34", "Local"))
            .evidence().contains("Maximum end ms: unavailable\n"));
        System.out.println("SUBTITLE_REGRESSIONS_PASSED=" + passed);
        System.out.println("SUBTITLE_REGRESSIONS_FAILED=" + failed);
        if (failed != 0) throw new AssertionError("subtitle export regressions: " + failed);
    }
}
