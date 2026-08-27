import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native';

import {
  hasBackgroundProcessingConsent,
  setBackgroundProcessingConsent,
} from '@/services/background-processing-consent';
import {
  listDownloadedTranscriptionModels,
  removeDownloadedTranscriptionModels,
  type DownloadedTranscriptionModel,
} from '@/services/transcription';
import {
  listDownloadedNaturalTranslationModel,
  removeDownloadedNaturalTranslationModel,
  type DownloadedNaturalTranslationModel,
} from '@/services/caption-translation';

const POLICY_URL = 'https://hatsunama.github.io/Caption-Studio/privacy/';
const PRIVATE_CONTACT_URL = 'https://github.com/Hatsunama/Caption-Studio/security/advisories/new';
const PUBLIC_SUPPORT_URL = 'https://github.com/Hatsunama/Caption-Studio/issues/new';

export default function PrivacyScreen() {
  const router = useRouter();
  const [backgroundConsent, setBackgroundConsent] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<DownloadedTranscriptionModel[]>([]);
  const [translationModels, setTranslationModels] = useState<DownloadedNaturalTranslationModel[]>([]);

  useEffect(() => {
    let active = true;
    void hasBackgroundProcessingConsent().then((granted) => {
      if (active) setBackgroundConsent(granted);
    });
    void listDownloadedTranscriptionModels().then((models) => {
      if (active) setDownloadedModels(models);
    });
    void listDownloadedNaturalTranslationModel().then((models) => {
      if (active) setTranslationModels(models);
    });
    return () => { active = false; };
  }, []);

  const revokeBackgroundProcessing = () => {
    Alert.alert(
      'Turn off background-removal processing?',
      'This stops future MediaPipe and ML Kit background-removal work until you review and accept the disclosure again. Other editing features keep working.',
      [
        { text: 'Keep enabled', style: 'cancel' },
        {
          text: 'Turn off',
          style: 'destructive',
          onPress: () => {
            void setBackgroundProcessingConsent(false)
              .then(() => setBackgroundConsent(false))
              .catch(() => Alert.alert('Could not update privacy choice', 'Try again.'));
          },
        },
      ],
    );
  };

  const removeTranslationModel = () => {
    const size = formatStorage(translationModels.reduce((total, model) => total + model.sizeBytes, 0));
    Alert.alert(
      'Remove natural translation model?',
      `This frees about ${size}. Saved English and Chinese subtitles stay intact. The model downloads again only if you request another automatic translation.`,
      [
        { text: 'Keep model', style: 'cancel' },
        {
          text: 'Remove model',
          style: 'destructive',
          onPress: () => {
            void removeDownloadedNaturalTranslationModel()
              .then(() => setTranslationModels([]))
              .catch((error) => Alert.alert('Could not remove model', error instanceof Error ? error.message : 'Try again.'));
          },
        },
      ],
    );
  };

  const removeOfflineModels = () => {
    const size = formatStorage(downloadedModels.reduce((total, model) => total + model.sizeBytes, 0));
    Alert.alert(
      'Remove offline transcription models?',
      `This frees about ${size}. Saved captions and projects stay intact. A model will download again the next time you generate captions with it.`,
      [
        { text: 'Keep models', style: 'cancel' },
        {
          text: 'Remove models',
          style: 'destructive',
          onPress: () => {
            void removeDownloadedTranscriptionModels()
              .then(() => setDownloadedModels([]))
              .catch((error) => Alert.alert('Could not remove models', error instanceof Error ? error.message : 'Try again.'));
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: '#090B0E' }}
      contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 18 }}>
      <PolicySection title="Caption Studio privacy policy">
        Effective August 27, 2026. Caption Studio is provided by Hatsunama. The app is a local-first
        video and caption editor and does not require an account.
      </PolicySection>
      <PolicySection title="What stays on your phone">
        Videos, audio, images, imported fonts, transcripts, person masks, projects, and exports are
        processed and stored locally. Caption Studio does not upload this content to Hatsunama and
        does not include advertising, first-party analytics, tracking, or cloud transcription SDKs.
        MediaPipe performs multiclass person segmentation locally, and ML Kit performs local face
        detection to stabilize difficult facial edges. Video frames and masks stay on your device. When
        background removal is enabled and used, Google states that ML Kit collects device and app data,
        a per-installation identifier, performance, configuration, input/output-size, feature-version,
        event, and error metrics. Google&apos;s MediaPipe terms say its APIs contact Google for fixes,
        updated models, and accelerator compatibility and send utilization and performance metrics.
      </PolicySection>
      <PolicySection title="Model downloads">
        When you first choose a transcription model, the app downloads the selected Whisper model
        and its speech detector from Hugging Face. Optional natural English–Chinese translation uses
        one separate, approximately 1.6 GB Qwen model for both directions and both Chinese scripts.
        These requests necessarily reveal ordinary network information such as your IP address to
        Hugging Face. Your media, transcript, and translation are not part of a model request.
        Downloaded files are verified by exact size and SHA-256 before use, and inference stays local.
      </PolicySection>
      <PolicySection title="Media access and sharing">
        Caption Studio only receives media you select through Android system pickers. Exports are
        saved to your device media library when supported. Sharing or uploading an export is a
        separate action you control outside Caption Studio.
      </PolicySection>
      <PolicySection title="Optional background-removal processing">
        Background removal is optional. Before its first use, Caption Studio asks you to accept local
        person processing and Google&apos;s encrypted operational metrics. Those metrics include app,
        device, performance, configuration, event, error, and input/output-size information, but not
        your video frames or generated masks. Google states that ML Kit encrypts collected data in transit
        and does not transfer it to third parties. You can turn future background-removal processing off here.
      </PolicySection>
      <PolicySection title="Retention and deletion">
        Project data remains on the device until you delete the project, clear app storage, or uninstall
        the app. Downloaded transcription and translation models can also be removed below. Deleting a project removes
        Caption Studio-managed project files but never deletes the original media you selected. A recovery
        copy is staged in private cache only while Android&apos;s share sheet is open and is then deleted;
        interrupted staging files are removed after 24 hours when the project library opens. Exported files
        remain in the media library until you delete them there.
      </PolicySection>
      <PolicySection title="Security and children">
        Caption Studio restricts generated files to app-controlled storage, verifies downloaded model
        files, and uses Android system media access. Android cloud backup is disabled. On Android 12 and
        newer, some manufacturers can still include app data in direct device-to-device migration. It is
        a general-purpose creator tool and is not designed for children under 13.
      </PolicySection>
      <PolicySection title="Contact">
        Confidential privacy and security reports use GitHub&apos;s private security-advisory form and
        require a GitHub account. Public support issues must never contain personal information, private
        media, transcripts, project files, or device logs.
      </PolicySection>
      <View style={{ gap: 10 }}>
        {backgroundConsent ? (
          <PolicyAction label="Turn off optional background-removal processing" onPress={revokeBackgroundProcessing} />
        ) : (
          <View style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#20262E' }}>
            <Text style={{ color: '#B8C1CC', fontSize: 14, fontWeight: '700' }}>Optional background-removal processing is off</Text>
          </View>
        )}
        {downloadedModels.length > 0 ? (
          <PolicyAction
            label={`Remove offline models · ${formatStorage(downloadedModels.reduce((total, model) => total + model.sizeBytes, 0))}`}
            onPress={removeOfflineModels}
          />
        ) : (
          <View style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#20262E' }}>
            <Text style={{ color: '#B8C1CC', fontSize: 14, fontWeight: '700' }}>No transcription models are currently downloaded</Text>
          </View>
        )}
        {translationModels.length > 0 ? (
          <PolicyAction
            label={`Remove natural translation model · ${formatStorage(translationModels.reduce((total, model) => total + model.sizeBytes, 0))}`}
            onPress={removeTranslationModel}
          />
        ) : (
          <View style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#20262E' }}>
            <Text style={{ color: '#B8C1CC', fontSize: 14, fontWeight: '700' }}>Optional natural translation model is not downloaded</Text>
          </View>
        )}
        <PolicyAction label="View bundled software, model, and font notices" onPress={() => router.push('/notices')} />
        <PolicyLink label="Open the public privacy policy" url={POLICY_URL} />
        <PolicyLink label="Send a confidential privacy or security report" url={PRIVATE_CONTACT_URL} />
        <PolicyLink label="Open public support · never post private data" url={PUBLIC_SUPPORT_URL} />
      </View>
    </ScrollView>
  );
}

function formatStorage(bytes: number) {
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

function PolicyAction(props: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#20262E' }}>
      <Text style={{ color: '#DFFF35', fontSize: 14, fontWeight: '800' }}>{props.label}</Text>
    </Pressable>
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
