import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';

export default function ThankYouScreen() {
  const router = useRouter();

  return <ScrollView
    style={{ flex: 1, backgroundColor: '#FFF8FC' }}
    contentContainerStyle={{ flexGrow: 1, alignItems: 'center', padding: 28 }}>
    <Text style={{ width: '100%', marginTop: 48, textAlign: 'center', color: '#E84AA0', fontSize: 28, fontWeight: '700' }}>
      Thank you
    </Text>
    <Text style={{ width: '100%', marginTop: 16, textAlign: 'center', color: '#2D2140', fontSize: 16, lineHeight: 24 }}>
      Thanks for downloading Caption Studio and spending time with it. Hope the captions make your world a little brighter.
    </Text>
    <View style={{ width: '100%', marginTop: 20, padding: 16, borderRadius: 24, borderWidth: 2, borderColor: '#D4B8FF', backgroundColor: '#F5EEFF' }}>
      <Text style={{ textAlign: 'center', color: '#8B7A9A', fontSize: 14 }}>
        If you want to support Hatsu please subscribe to the Patreon @Hatsunama
      </Text>
    </View>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back to Home"
      onPress={() => router.back()}
      style={({ pressed }) => ({
        width: '100%',
        minHeight: 52,
        marginTop: 28,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 28,
        backgroundColor: pressed ? '#E84AA0' : '#FF6BB5',
      })}>
      <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '700' }}>Back to Home</Text>
    </Pressable>
  </ScrollView>;
}
