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
    private Validator() {}
    public static final class Result {
        public final int bytes, cues;
        public final String sha256, error;
        Result(int bytes, String sha256, int cues, String error) {
            this.bytes = bytes; this.sha256 = sha256; this.cues = cues; this.error = error;
        }
        public String evidence() {
            return "Bytes: " + bytes + "\nSHA256: " + sha256
                + "\nCue count: " + cues + "\nError: " + error;
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
        Lines lines = new Lines(text);
        String line = lines.next();
        if (line != null && line.startsWith("\ufeff")) line = line.substring(1);
        int cues = 0;
        while (line != null) {
            if (!line.equals(Integer.toString(cues + 1))) {
                String error = line.matches("[0-9]+") || cues == 0 ? "NUMBER_SEQUENCE" : "PREMATURE_BLANK_OR_NUMBER";
                return new Result(length, sha, cues, error);
            }
            String timing = lines.next();
            Matcher m = TIME.matcher(timing == null ? "" : timing);
            if (!m.matches()) return new Result(length, sha, cues, "TIMESTAMP_SYNTAX");
            if (millis(m, 5) <= millis(m, 1)) return new Result(length, sha, cues, "TIMESTAMP_ORDER");
            int contentLines = 0;
            while ((line = lines.next()) != null && !line.trim().isEmpty()) contentLines++;
            if (contentLines == 0) return new Result(length, sha, cues, "EMPTY_CUE");
            cues++;
            while (line != null && line.trim().isEmpty()) line = lines.next();
        }
        return new Result(length, sha, cues, "NONE");
    }
    private static long millis(Matcher m, int group) {
        return Long.parseLong(m.group(group)) * 3600000L
            + Long.parseLong(m.group(group + 1)) * 60000L
            + Long.parseLong(m.group(group + 2)) * 1000L
            + Long.parseLong(m.group(group + 3));
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
