package app.captionstudio.verification.sharereceiver;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class Validator {
    public static final int MAX_BYTES = 1024 * 1024;
    private static final Pattern TIME = Pattern.compile(
        "([0-9]{2,9}):([0-5][0-9]):([0-5][0-9]),([0-9]{3}) --> ([0-9]{2,9}):([0-5][0-9]):([0-5][0-9]),([0-9]{3})");
    private static final Pattern ASS_TIME = Pattern.compile(
        "([0-9]{1,9}):([0-5][0-9]):([0-5][0-9])\\.([0-9]{2})");
    private Validator() {}
    public static final class Result {
        public final int bytes, cues;
        public final String sha256, error, format;
        public final long firstStartMs, maximumEndMs;
        Result(int bytes, String sha256, int cues, String error) {
            this(bytes, sha256, cues, error, "UNKNOWN", -1, -1);
        }
        Result(int bytes, String sha256, int cues, String error, String format,
                long firstStartMs, long maximumEndMs) {
            this.bytes = bytes; this.sha256 = sha256; this.cues = cues; this.error = error;
            this.format = format;
            this.firstStartMs = error.equals("NONE") ? firstStartMs : -1;
            this.maximumEndMs = error.equals("NONE") ? maximumEndMs : -1;
        }
        public String evidence() {
            return "Format: " + format + "\nBytes: " + bytes + "\nSHA256: " + sha256
                + "\nCue count: " + cues
                + "\nFirst start ms: " + scalar(firstStartMs)
                + "\nMaximum end ms: " + scalar(maximumEndMs) + "\nError: " + error;
        }
        private static String scalar(long value) {
            return value < 0 ? "unavailable" : Long.toString(value);
        }
    }
    public static Result inspect(byte[] bytes, int length) {
        if (length < 0 || length > MAX_BYTES || length > bytes.length)
            return new Result(-1, "unavailable", 0, "SIZE");
        String sha = digest(bytes, length);
        if (length == 0) return new Result(0, sha, 0, "EMPTY");
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, 0, length)).toString();
        } catch (CharacterCodingException e) { return new Result(length, sha, 0, "UTF8"); }
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\r' && (i + 1 == text.length() || text.charAt(i + 1) != '\n'))
                return new Result(length, sha, 0, "LINE_ENDING");
            if ((c < 32 && c != '\n' && c != '\r' && c != '\t') || c == 127)
                return new Result(length, sha, 0, "CONTROL_CHARACTER");
        }
        if (text.startsWith("\ufeff")) text = text.substring(1);
        Lines probe = new Lines(text);
        String firstLine;
        do { firstLine = probe.next(); } while (firstLine != null && firstLine.trim().isEmpty());
        if (firstLine != null && firstLine.trim().startsWith("[")) return inspectAss(text, length, sha);
        return inspectSrt(text, length, sha);
    }
    private static Result inspectSrt(String text, int length, String sha) {
        Lines lines = new Lines(text);
        String line = lines.next();
        int cues = 0;
        long first = -1, maximum = -1;
        while (line != null) {
            if (!line.equals(Integer.toString(cues + 1))) {
                String error = line.matches("[0-9]+") || cues == 0 ? "NUMBER_SEQUENCE" : "PREMATURE_BLANK_OR_NUMBER";
                return new Result(length, sha, cues, error, "SRT", first, maximum);
            }
            String timing = lines.next();
            Matcher m = TIME.matcher(timing == null ? "" : timing);
            if (!m.matches()) return new Result(length, sha, cues, "TIMESTAMP_SYNTAX", "SRT", first, maximum);
            long start = millis(m, 1, 1), end = millis(m, 5, 1);
            if (end <= start) return new Result(length, sha, cues, "TIMESTAMP_ORDER", "SRT", first, maximum);
            int contentLines = 0;
            while ((line = lines.next()) != null && !line.trim().isEmpty()) contentLines++;
            if (contentLines == 0) return new Result(length, sha, cues, "EMPTY_CUE", "SRT", first, maximum);
            if (cues == 0) first = start;
            maximum = Math.max(maximum, end);
            cues++;
            while (line != null && line.trim().isEmpty()) line = lines.next();
        }
        return new Result(length, sha, cues, "NONE", "SRT", first, maximum);
    }
    private static Result inspectAss(String text, int length, String sha) {
        Lines lines = new Lines(text);
        boolean events = false;
        int columns = 0, startColumn = -1, endColumn = -1, cues = 0;
        long first = -1, maximum = -1;
        String line;
        while ((line = lines.next()) != null) {
            line = line.trim();
            if (line.isEmpty() || line.startsWith(";")) continue;
            if (line.startsWith("[") && line.endsWith("]")) {
                events = line.equalsIgnoreCase("[Events]");
                columns = 0;
                continue;
            }
            if (!events) continue;
            if (line.startsWith("Format:")) {
                // Bound schema allocations even for hostile 1 MiB input.
                if (line.length() > 512) return new Result(length, sha, cues, "ASS_FORMAT", "ASS", first, maximum);
                String[] fields = line.substring(7).split(",", -1);
                if (fields.length < 3 || fields.length > 32
                        || !fields[fields.length - 1].trim().equalsIgnoreCase("Text"))
                    return new Result(length, sha, cues, "ASS_FORMAT", "ASS", first, maximum);
                startColumn = -1; endColumn = -1;
                for (int i = 0; i < fields.length; i++) {
                    fields[i] = fields[i].trim();
                    if (fields[i].isEmpty()) return new Result(length, sha, cues, "ASS_FORMAT", "ASS", first, maximum);
                    for (int j = 0; j < i; j++)
                        if (fields[i].equalsIgnoreCase(fields[j]))
                            return new Result(length, sha, cues, "ASS_FORMAT", "ASS", first, maximum);
                    if (fields[i].equalsIgnoreCase("Start")) startColumn = i;
                    if (fields[i].equalsIgnoreCase("End")) endColumn = i;
                }
                if (startColumn < 0 || endColumn < 0)
                    return new Result(length, sha, cues, "ASS_FORMAT", "ASS", first, maximum);
                columns = fields.length;
                continue;
            }
            if (line.startsWith("Comment:")) continue;
            if (!line.startsWith("Dialogue:"))
                return new Result(length, sha, cues, "ASS_EVENT_SYNTAX", "ASS", first, maximum);
            if (columns == 0) return new Result(length, sha, cues, "ASS_FORMAT", "ASS", first, maximum);
            // Positive split limit leaves commas and ASS escapes inside Text intact.
            String[] fields = line.substring(9).split(",", columns);
            if (fields.length != columns)
                return new Result(length, sha, cues, "ASS_EVENT_SYNTAX", "ASS", first, maximum);
            Matcher startMatch = ASS_TIME.matcher(fields[startColumn].trim());
            Matcher endMatch = ASS_TIME.matcher(fields[endColumn].trim());
            if (!startMatch.matches() || !endMatch.matches())
                return new Result(length, sha, cues, "TIMESTAMP_SYNTAX", "ASS", first, maximum);
            long start = millis(startMatch, 1, 10), end = millis(endMatch, 1, 10);
            if (end <= start) return new Result(length, sha, cues, "TIMESTAMP_ORDER", "ASS", first, maximum);
            if (fields[columns - 1].trim().isEmpty())
                return new Result(length, sha, cues, "EMPTY_CUE", "ASS", first, maximum);
            if (cues == 0) first = start;
            maximum = Math.max(maximum, end);
            cues++;
        }
        return new Result(length, sha, cues, cues == 0 ? "EMPTY_CUE" : "NONE", "ASS", first, maximum);
    }
    private static long millis(Matcher m, int group, int fractionScale) {
        return Long.parseLong(m.group(group)) * 3600000L
            + Long.parseLong(m.group(group + 1)) * 60000L
            + Long.parseLong(m.group(group + 2)) * 1000L
            + Long.parseLong(m.group(group + 3)) * fractionScale;
    }
    private static String digest(byte[] bytes, int length) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(bytes, 0, length);
            byte[] hash = digest.digest();
            char[] hex = new char[hash.length * 2];
            char[] alphabet = "0123456789abcdef".toCharArray();
            for (int i = 0; i < hash.length; i++) {
                hex[i * 2] = alphabet[(hash[i] & 255) >>> 4];
                hex[i * 2 + 1] = alphabet[hash[i] & 15];
            }
            return new String(hex);
        } catch (NoSuchAlgorithmException impossible) { throw new AssertionError("SHA256 unavailable"); }
    }
    // Streaming line scan avoids a per-line array/object explosion for hostile input.
    private static final class Lines {
        private final String value;
        private int position;
        Lines(String value) { this.value = value; }
        String next() {
            if (position >= value.length()) return null;
            int end = value.indexOf('\n', position);
            if (end < 0) end = value.length();
            int contentEnd = end > position && value.charAt(end - 1) == '\r' ? end - 1 : end;
            String result = value.substring(position, contentEnd);
            position = end + 1;
            return result;
        }
    }
}
