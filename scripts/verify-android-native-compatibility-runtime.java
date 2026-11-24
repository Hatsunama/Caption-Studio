// Public-certificate verification only. No signing or private-key APIs.
import java.util.HexFormat;
import java.util.Locale;
import java.util.jar.JarFile;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;

class VerifyFinalBundle {
    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !args[1].matches("[0-9a-f]{64}")) throw new Exception("Arguments");
        int payloads = 0;
        byte[] buffer = new byte[65536];
        try (JarFile jar = new JarFile(args[0], true)) {
            var entries = jar.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                try (var input = jar.getInputStream(entry)) {
                    while (input.read(buffer) != -1) { }
                }
                String name = entry.getName().toUpperCase(Locale.ROOT);
                if (entry.isDirectory() || name.matches("META-INF/(MANIFEST\\.MF|[^/]+\\.(SF|RSA|DSA|EC)|SIG-[^/]+)")) continue;
                var signers = entry.getCodeSigners();
                if (signers == null || signers.length != 1) throw new Exception("Unsigned payload");
                var cert = (X509Certificate) signers[0].getSignerCertPath().getCertificates().get(0);
                cert.checkValidity();
                String actual = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
                if (!actual.equals(args[1])) throw new Exception("Certificate mismatch");
                payloads++;
            }
        }
        if (payloads == 0) throw new Exception("Empty bundle");
        System.out.println("VERIFIED");
    }
}
