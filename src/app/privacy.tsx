import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';

import { chrome } from '@/lib/ui-theme';
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
import { shareLocalProcessExits } from '@/services/local-diagnostics';

export default function PrivacyScreen() {
  const router = useRouter();
  const [downloadedModels, setDownloadedModels] = useState<DownloadedTranscriptionModel[]>([]);
  const [translationModels, setTranslationModels] = useState<DownloadedNaturalTranslationModel[]>([]);

  useEffect(() => {
    let active = true;
    void listDownloadedTranscriptionModels().then((models) => {
      if (active) setDownloadedModels(models);
    });
    void listDownloadedNaturalTranslationModel().then((models) => {
      if (active) setTranslationModels(models);
    });
    return () => { active = false; };
  }, []);

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

  const shareDiagnostics = () => {
    Alert.alert(
      'Share local crash diagnostics?',
      'The file contains only Android exit categories, times, memory totals, and app version numbers. It never includes media, captions, project names, or file paths.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Share',
          onPress: () => {
            void shareLocalProcessExits().catch((error) => Alert.alert(
              'Could not share diagnostics',
              error instanceof Error ? error.message : 'Try again.',
            ));
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: chrome.background }}
      contentContainerStyle={{ padding: 20, paddingBottom: 48, gap: 18 }}>
      <PolicySection title="Caption Studio privacy policy">
        Effective August 27, 2026. Caption Studio is provided by Hatsunama. The app is a local-first
        video and caption editor and does not require an account.
      </PolicySection>
      <PolicySection title="What stays on your phone">
        Videos, audio, images, imported fonts, transcripts, projects, and exports are
        processed and stored locally. Caption Studio does not upload this content to Hatsunama and
        does not include advertising, first-party analytics, tracking, or cloud transcription SDKs.
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
      <PolicySection title="Retention and deletion">
        Project data remains on the device until you delete the project, clear app storage, or uninstall
        the app. Downloaded transcription and translation models can also be removed below. Deleting a project removes
        Caption Studio-managed project files but never deletes the original media you selected. A recovery
        copy is staged in private cache only while Android&apos;s share sheet is open and is then deleted;
        interrupted staging files are removed after 24 hours when the project library opens. Exported files
        remain in the media library until you delete them there. Unsaved caption text is journaled in private
        app storage so it can be recovered after a process exit, then cleared after Save or explicit Discard.
        A bounded local diagnostic history stores only Android exit categories, times, memory totals, and app
        version numbers. It never stores media, captions, names, or file paths and is shared only when you tap Share.
      </PolicySection>
      <PolicySection title="Security and children">
        Caption Studio restricts generated files to app-controlled storage, verifies downloaded model
        files, and uses Android system media access. Android cloud backup is disabled. On Android 12 and
        newer, some manufacturers can still include app data in direct device-to-device migration. It is
        a general-purpose creator tool and is not designed for children under 13.
      </PolicySection>
      <PolicySection title="Contact">
        For privacy questions, security reports, copyright or DMCA notices, legal takedown requests, or
        reports about generated output, contact xmilo_at_your_side@proton.me. Do not include private
        media, transcripts, project files, device logs, or passwords in your first message.
      </PolicySection>
      <PolicySection title="Generated captions and translations">
        AI captions and translations may be inaccurate or unsuitable. Review them before exporting. You
        can edit, hide, or delete generated text at any time; Caption Studio does not silently alter your
        original media.
      </PolicySection>
      <View style={{ gap: 10 }}>
        {downloadedModels.length > 0 ? (
          <PolicyAction
            label={`Remove offline models · ${formatStorage(downloadedModels.reduce((total, model) => total + model.sizeBytes, 0))}`}
            onPress={removeOfflineModels}
          />
        ) : (
        <View style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: chrome.radius.md, backgroundColor: chrome.surface }}>
            <Text style={{ color: chrome.muted, fontSize: 14, fontWeight: '600' }}>No transcription models are currently downloaded</Text>
          </View>
        )}
        {translationModels.length > 0 ? (
          <PolicyAction
            label={`Remove natural translation model · ${formatStorage(translationModels.reduce((total, model) => total + model.sizeBytes, 0))}`}
            onPress={removeTranslationModel}
          />
        ) : (
        <View style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: chrome.radius.md, backgroundColor: chrome.surface }}>
            <Text style={{ color: chrome.muted, fontSize: 14, fontWeight: '600' }}>Optional natural translation model is not downloaded</Text>
          </View>
        )}
        <PolicyAction label="View bundled software, model, and font notices" onPress={() => router.push('/notices')} />
        <PolicyAction label="Share sanitized local crash diagnostics" onPress={shareDiagnostics} />
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
      style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 16, borderRadius: chrome.radius.lg, backgroundColor: chrome.surface }}>
      <Text style={{ color: chrome.accent, fontSize: 15, fontWeight: '600' }}>{props.label}</Text>
    </Pressable>
  );
}

function PolicySection(props: { title: string; children: string }) {
  return (
    <View style={{ gap: 7 }}>
      <Text selectable style={{ color: chrome.text, fontSize: 18, fontWeight: '700' }}>{props.title}</Text>
      <Text selectable style={{ color: chrome.muted, fontSize: 14, lineHeight: 21 }}>{props.children}</Text>
    </View>
  );
}
