import { useCallback, useEffect, useState } from 'react';
import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  Text,
  View,
} from 'react-native';

import { MediaLoadingOverlay } from '@/components/media-loading-overlay';
import { totalClipDuration } from '@/lib/video-timeline';
import type { MediaImportProgress } from '@/services/media-import';
import { shareProjectRecoveryRecord } from '@/services/project-recovery';
import {
  deleteProjectCompletely,
  deleteUnreadableProjectCompletely,
  ensureLibraryProjectThumbnail,
  importVideoProject,
  loadProjectLibrary,
} from '@/services/project-workflows';
import { chrome } from '@/lib/ui-theme';
import type { CaptionProject } from '@/types/project';
import type { ProjectRecordSummary } from '@/types/project-library';

const palette = {
  background: chrome.background,
  surface: chrome.surface,
  surfaceRaised: chrome.surfaceRaised,
  text: chrome.text,
  muted: chrome.muted,
  accent: chrome.accent,
  border: chrome.hairline,
};

export default function ProjectsScreen() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRecordSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<MediaImportProgress>();

  const refresh = useCallback(async () => {
    setLoadError(undefined);
    try {
      setProjects(await loadProjectLibrary());
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Caption Studio could not read the project library.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  const importVideo = async () => {
    setImporting(true);
    try {
      const project = await importVideoProject(setImportProgress);
      if (!project) return;
      router.push({
        pathname: '/editor',
        params: { projectId: project.id },
      });
    } catch (error) {
      Alert.alert(
        'Could not import video',
        error instanceof Error ? error.message : 'The selected video could not be copied.',
      );
    } finally {
      setImportProgress(undefined);
      setImporting(false);
    }
  };

  const confirmDeleteUnreadableProject = (project: Extract<ProjectRecordSummary, { kind: 'unreadable' }>) => {
    Alert.alert(
      'Delete unreadable project?',
      `“${project.name}” cannot be opened. Save a recovery copy first if you may need its raw project data. Original videos will not be changed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete project',
          style: 'destructive',
          onPress: () => {
            void deleteUnreadableProjectCompletely(project.id)
              .then(refresh)
              .catch((error) => Alert.alert('Could not delete project', error instanceof Error ? error.message : 'Try again.'));
          },
        },
      ],
    );
  };

  const confirmDeleteProject = (project: CaptionProject) => {
    Alert.alert(
      'Delete this project?',
      `“${project.name}” and its Caption Studio edits will be removed. Your original videos will not be changed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete project',
          style: 'destructive',
          onPress: () => {
            void deleteProjectCompletely(project.id)
              .then(refresh)
              .catch((error) => Alert.alert('Could not delete project', error instanceof Error ? error.message : 'Try again.'));
          },
        },
      ],
    );
  };

  return <>
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: palette.background }}
      contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 48 }}
      data={projects}
      keyExtractor={(item) => item.kind === 'project' ? item.project.id : item.id}
      ListHeaderComponent={
        <View style={{ gap: 18 }}>
          <View style={{ gap: 6 }}>
            <Text selectable style={{ color: palette.text, fontSize: 34, fontWeight: '700' }}>
              Captions first.
            </Text>
            <Text selectable style={{ color: palette.muted, fontSize: 16, lineHeight: 23 }}>
              Import a video, generate captions locally, then style every word without credits,
              quotas, or a watermark.
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Import a video"
            disabled={importing}
            onPress={importVideo}
            style={({ pressed }) => ({
              minHeight: 142,
                          borderRadius: chrome.radius.lg,
              padding: 20,
              justifyContent: 'space-between',
              backgroundColor: pressed ? chrome.accentPressed : palette.accent,
            })}>
            <Text style={{ color: chrome.accentInk, fontSize: 13, fontWeight: '600' }}>
              NEW PROJECT
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <Text style={{ color: chrome.accentInk, fontSize: 28, lineHeight: 32, fontWeight: '800' }}>
                Import video{`\n`}→ Generate captions
              </Text>
              {importing ? <ActivityIndicator color="#11140C" /> : <Text style={{ fontSize: 36 }}>＋</Text>}
            </View>
          </Pressable>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            {['Offline after model download', 'No watermark', 'Unlimited styles'].map((label) => (
              <View
                key={label}
                style={{
                  flex: 1,
                  minHeight: 74,
                  justifyContent: 'center',
                  borderRadius: chrome.radius.lg,
                  padding: 12,
                  backgroundColor: palette.surface,
                  borderWidth: 1,
                  borderColor: palette.border,
                }}>
                <Text style={{ color: palette.text, fontSize: 12, lineHeight: 16, fontWeight: '600' }}>
                  {label}
                </Text>
              </View>
            ))}
          </View>

          <Text selectable style={{ color: palette.text, fontSize: 19, fontWeight: '700', marginTop: 6 }}>
            Projects
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View
          style={{
            minHeight: 150,
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            borderRadius: 20,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: palette.border,
          }}>
          {loading ? (
            <ActivityIndicator color={palette.accent} />
          ) : loadError ? (
            <>
              <Text style={{ color: '#FFBBC8', fontSize: 17, fontWeight: '700' }}>Projects could not be loaded</Text>
              <Text style={{ color: palette.muted, fontSize: 13, textAlign: 'center' }}>{loadError}</Text>
              <Pressable accessibilityRole="button" onPress={() => void refresh()} style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: chrome.radius.pill, backgroundColor: palette.accent }}>
                <Text style={{ color: chrome.accentInk, fontWeight: '700' }}>Retry</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={{ color: palette.text, fontSize: 17, fontWeight: '700' }}>No projects yet</Text>
              <Text style={{ color: palette.muted, fontSize: 14 }}>Your first import will appear here.</Text>
            </>
          )}
        </View>
      }
      ListFooterComponent={
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open Caption Studio privacy policy"
          onPress={() => router.push('/privacy')}
          style={{ alignSelf: 'center', minHeight: 48, justifyContent: 'center', paddingHorizontal: 18 }}>
          <Text style={{ color: palette.muted, fontSize: 13, fontWeight: '700' }}>Privacy policy</Text>
        </Pressable>
      }
      renderItem={({ item }) => item.kind === 'project' ? (
        <ProjectCard
          project={item.project}
          onOpen={() => router.push({ pathname: '/editor', params: { projectId: item.project.id } })}
          onDelete={() => confirmDeleteProject(item.project)}
        />
      ) : (
        <View style={{ gap: 10, padding: 16, borderRadius: 18, borderWidth: 1, borderColor: '#7A3243', backgroundColor: '#24151B' }}>
          <Text numberOfLines={1} style={{ color: '#FFD7E0', fontSize: 16, fontWeight: '800' }}>{item.name}</Text>
          <Text style={{ color: '#FFBBC8', fontSize: 13, fontWeight: '700' }}>This saved project is unreadable</Text>
          <Text numberOfLines={3} style={{ color: palette.muted, fontSize: 12, lineHeight: 17 }}>{item.reason}</Text>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void shareProjectRecoveryRecord(item.id, item.name)
                .catch((error) => Alert.alert('Could not save recovery copy', error instanceof Error ? error.message : 'Try again.'))}
              style={{ flex: 1, alignItems: 'center', padding: 11, borderRadius: 12, backgroundColor: '#27313C' }}>
              <Text style={{ color: palette.text, fontWeight: '800', fontSize: 12 }}>Save recovery copy</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete unreadable project ${item.name}`}
              onPress={() => confirmDeleteUnreadableProject(item)}
              style={{ alignItems: 'center', padding: 11, borderRadius: 12, backgroundColor: '#49212B' }}>
              <Text style={{ color: '#FFBBC8', fontWeight: '800', fontSize: 12 }}>Delete</Text>
            </Pressable>
          </View>
        </View>
      )}
    />
    <MediaLoadingOverlay progress={importProgress} />
  </>;
}

function ProjectCard(props: { project: CaptionProject; onOpen: () => void; onDelete: () => void }) {
  const [thumbnailUri, setThumbnailUri] = useState(props.project.sources[0]?.thumbnailUri);
  useEffect(() => {
    let active = true;
    void ensureLibraryProjectThumbnail(props.project)
      .then((prepared) => {
        if (active) setThumbnailUri(prepared.sources[0]?.thumbnailUri);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [props.project]);

  return (
    <Pressable onPress={props.onOpen} style={{ position: 'relative', flexDirection: 'row', gap: 14, padding: 14, borderRadius: chrome.radius.lg, backgroundColor: palette.surfaceRaised }}>
      {thumbnailUri ? (
        <Image source={{ uri: thumbnailUri }} style={{ width: 74, height: 74, borderRadius: chrome.radius.md, backgroundColor: '#050607' }} contentFit="cover" transition={160} />
      ) : (
        <View style={{ width: 74, height: 74, borderRadius: chrome.radius.md, backgroundColor: '#050607', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: palette.muted, fontSize: 11, fontWeight: '800' }}>VIDEO</Text>
        </View>
      )}
      <View style={{ flex: 1, justifyContent: 'center', gap: 5 }}>
        <Text numberOfLines={1} style={{ color: palette.text, fontSize: 16, fontWeight: '700', paddingRight: 36 }}>{props.project.name}</Text>
        <Text style={{ color: palette.muted, fontSize: 13 }}>
          {props.project.lifecycle.status === 'draft' ? 'DRAFT · ' : ''}{props.project.clips.length} clip{props.project.clips.length === 1 ? '' : 's'} · {props.project.captions.length} subtitles · {formatDuration(totalClipDuration(props.project.clips))}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${props.project.name}`}
        hitSlop={10}
        onPress={(event) => { event.stopPropagation(); props.onDelete(); }}
        style={{ position: 'absolute', right: 10, top: 10, width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: chrome.dangerFill }}>
        <Text style={{ color: '#FF7C8D', fontSize: 17 }}>🗑</Text>
      </Pressable>
    </Pressable>
  );
}

function formatDuration(durationMs: number) {
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
