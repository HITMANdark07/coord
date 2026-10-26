import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { colors, fontSize, space } from "@wto/design-tokens";
import { PROTOCOL_VERSION } from "@wto/protocol";

// Phase 4: pair with the desktop over the relay, then wrap screens in <ClientProvider> from @wto/app-state.
export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Worktree Orchestrator</Text>
      <Text style={styles.muted}>protocol {PROTOCOL_VERSION} · pairing comes in Phase 4</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.light.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  title: { fontSize: fontSize.xl, fontWeight: "600", color: colors.light.text },
  muted: { fontSize: fontSize.sm, color: colors.light.muted },
});
