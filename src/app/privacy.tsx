import { Linking, Pressable, ScrollView, Text, View } from 'react-native';

const POLICY_URL = 'https://github.com/Hatsunama/Caption-Studio/blob/v1.3.1/PRIVACY.md';
const CONTACT_URL = 'https://github.com/Hatsunama/Caption-Studio/issues/new';

export default function PrivacyScreen() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: '#090B0E' }}
      contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 18 }}>
      <PolicySection title="Caption Studio privacy policy">
        Effective August 23, 2026. Caption Studio is provided by Hatsunama. The app is a local-first
        video and caption editor and does not require an account.
      </PolicySection>
      <PolicySection title="What stays on your phone">
        Videos, audio, images, imported fonts, transcripts, person masks, projects, and exports are
        processed and stored locally. Caption Studio does not upload this content to Hatsunama and
        does not include advertising, first-party analytics, tracking, or cloud transcription SDKs. Google ML Kit processes
        video frames locally and may send encrypted device, app, performance, configuration, event, and error metrics to
        Google for diagnostics and usage analytics; Google states that media inputs and outputs are not sent.
      </PolicySection>
      <PolicySection title="Model downloads">
        When you first choose a transcription model, the app downloads the selected Whisper model
        and its speech detector from Hugging Face. That request necessarily reveals ordinary network
        information such as your IP address to Hugging Face. Your media and transcript are not part
        of the request. Downloaded files are verified by exact size and SHA-256 before use.
      </PolicySection>
      <PolicySection title="Media access and sharing">
        Caption Studio only receives media you select through Android system pickers. Exports are
        saved to your device media library when supported. Sharing or uploading an export is a
        separate action you control outside Caption Studio.
      </PolicySection>
      <PolicySection title="Retention and deletion">
        Project data and downloaded models remain on the device until you delete the project, clear
        app storage, or uninstall the app. Deleting a project removes Caption Studio-managed project
        files but never deletes the original media you selected. Exported files remain in the media
        library until you delete them there.
      </PolicySection>
      <PolicySection title="Security and children">
        Caption Studio restricts generated files to app-controlled storage, verifies downloaded model
        files, and uses Android system media access. It is a general-purpose creator tool and is not
        designed for children under 13.
      </PolicySection>
      <View style={{ gap: 10 }}>
        <PolicyLink label="Open the public privacy policy" url={POLICY_URL} />
        <PolicyLink label="Ask a privacy question or report a concern" url={CONTACT_URL} />
      </View>
    </ScrollView>
  );
}

function PolicySection(props: { title: string; children: string }) {
  return (
    <View style={{ gap: 7 }}>
      <Text selectable style={{ color: '#F7F8FA', fontSize: 18, fontWeight: '800' }}>{props.title}</Text>
      <Text selectable style={{ color: '#B8C1CC', fontSize: 14, lineHeight: 21 }}>{props.children}</Text>
    </View>
  );
}

function PolicyLink(props: { label: string; url: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => void Linking.openURL(props.url)}
      style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#20262E' }}>
      <Text style={{ color: '#DFFF35', fontSize: 14, fontWeight: '800' }}>{props.label}</Text>
    </Pressable>
  );
}
