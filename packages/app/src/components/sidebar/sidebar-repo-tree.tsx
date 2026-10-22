import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { router, type Href } from "expo-router";
import { ChevronDown, ChevronRight, FolderGit2, GitBranch } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { DensityIcon } from "@/components/ui/density-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { sidebarWorkspaceRowStyles } from "@/components/sidebar/sidebar-workspace-row-content";
import type {
  SidebarProjectEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import {
  buildProjectRepoTree,
  type ProjectRepoTreeCheckout,
  type ProjectRepoTreeRepo,
} from "@/projects/project-repo-tree";
import { useSessionStore } from "@/stores/session-store";
import { selectProject } from "@/stores/session-store-hooks/selectors";
import { density, densityIconBox } from "@/styles/density";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

/**
 * A project's workspaces grouped Repo > Checkout > workspace, behind the `sidebarRepoTree`
 * preference. Rendered in place of the flat workspace list when the host reports repositories
 * for the project; otherwise it hands back `fallback` so hosts without `projectRepos` keep the
 * flat list.
 *
 * Reference repositories start collapsed. External checkouts (worktrees Paseo did not create or
 * adopt) are listed so the tree matches what git knows, but offer no action until adopted.
 */
export function SidebarRepoTreeChildren({
  project,
  serverId,
  displayName,
  renderWorkspaceRow,
  onWorkspacePress,
  fallback,
}: {
  project: SidebarProjectEntry;
  serverId: string;
  displayName: string;
  renderWorkspaceRow: (workspace: SidebarWorkspacePlacement) => ReactNode;
  onWorkspacePress?: () => void;
  fallback: ReactElement | null;
}): ReactElement | null {
  const projectId = project.hosts.find((host) => host.serverId === serverId)?.projectId ?? null;
  const repos = useSessionStore(
    useCallback(
      (state) => selectProject(state, serverId, projectId)?.repos ?? null,
      [serverId, projectId],
    ),
  );
  const tree = useMemo(
    () => (repos ? buildProjectRepoTree({ repos, workspaces: project.workspaces }) : null),
    [repos, project.workspaces],
  );
  const placementsByKey = useMemo(
    () => new Map(project.workspaces.map((workspace) => [workspace.workspaceKey, workspace])),
    [project.workspaces],
  );
  const [expandedOverrides, setExpandedOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const toggleRepo = useCallback((repo: ProjectRepoTreeRepo) => {
    setExpandedOverrides((current) => {
      const next = new Map(current);
      next.set(repo.relPath, !(current.get(repo.relPath) ?? repo.role !== "reference"));
      return next;
    });
  }, []);
  const openNewWorkspace = useCallback(
    (checkout: ProjectRepoTreeCheckout) => {
      if (!projectId) return;
      onWorkspacePress?.();
      router.navigate(
        buildNewWorkspaceRoute({
          serverId,
          sourceDirectory: checkout.path,
          displayName,
          projectId,
        }) as Href,
      );
    },
    [displayName, onWorkspacePress, projectId, serverId],
  );

  if (!tree || tree.repos.length === 0) {
    return fallback;
  }

  const renderKeys = (keys: readonly string[]) =>
    keys.map((key) => {
      const placement = placementsByKey.get(key);
      return placement ? (
        <View key={key} style={styles.workspaceIndent}>
          {renderWorkspaceRow(placement)}
        </View>
      ) : null;
    });

  return (
    <View testID={`sidebar-repo-tree-${project.viewKey}`}>
      {tree.repos.map((repo) => {
        const expanded = expandedOverrides.get(repo.relPath) ?? repo.role !== "reference";
        return (
          <View key={repo.relPath} role="group" accessibilityLabel={repo.name}>
            <RepoRow repo={repo} expanded={expanded} onToggle={toggleRepo} />
            {expanded
              ? repo.checkouts.map((checkout) => (
                  <View key={checkout.path}>
                    <CheckoutRow
                      checkout={checkout}
                      onNewWorkspace={projectId ? openNewWorkspace : null}
                    />
                    {renderKeys(checkout.workspaceKeys)}
                  </View>
                ))
              : null}
          </View>
        );
      })}
      {tree.otherWorkspaceKeys.length > 0 ? (
        <View role="group">
          <OtherWorkspacesRow />
          {renderKeys(tree.otherWorkspaceKeys)}
        </View>
      ) : null}
    </View>
  );
}

const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

function RepoRow({
  repo,
  expanded,
  onToggle,
}: {
  repo: ProjectRepoTreeRepo;
  expanded: boolean;
  onToggle: (repo: ProjectRepoTreeRepo) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onToggle(repo), [onToggle, repo]);
  return (
    <PressHighlight
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={repo.name}
      accessibilityState={expanded ? EXPANDED_STATE : COLLAPSED_STATE}
      onPress={handlePress}
      style={rowStyle}
      testID={`sidebar-repo-row-${repo.relPath}`}
    >
      <View style={styles.iconSlot}>
        <DensityIcon
          icon={expanded ? ChevronDown : ChevronRight}
          size="sm"
          color="foregroundMuted"
        />
      </View>
      <DensityIcon icon={FolderGit2} size="sm" color="foregroundMuted" />
      <Text style={styles.repoName} numberOfLines={1}>
        {repo.name}
      </Text>
      {repo.role === "reference" ? <Badge label={t("sidebar.repoTree.reference")} /> : null}
    </PressHighlight>
  );
}

function CheckoutRow({
  checkout,
  onNewWorkspace,
}: {
  checkout: ProjectRepoTreeCheckout;
  onNewWorkspace: ((checkout: ProjectRepoTreeCheckout) => void) | null;
}): ReactElement {
  const { t } = useTranslation();
  const actionable = onNewWorkspace !== null && (checkout.managed || checkout.isMain);
  const handlePress = useCallback(() => onNewWorkspace?.(checkout), [checkout, onNewWorkspace]);
  const label = checkout.branch ?? (checkout.detached ? "HEAD" : checkout.path);
  return (
    <PressHighlight
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityLabel={
        actionable ? `${label}: ${t("sidebar.repoTree.newWorkspaceHere")}` : label
      }
      disabled={!actionable}
      onPress={handlePress}
      style={checkoutRowStyle}
      testID={`sidebar-checkout-row-${checkout.path}`}
    >
      <View style={styles.iconSlot}>
        <DensityIcon icon={GitBranch} size="sm" color="foregroundMuted" />
      </View>
      <Text style={styles.checkoutLabel} numberOfLines={1}>
        {label}
      </Text>
      {checkout.isMain ? <Badge label={t("sidebar.repoTree.main")} /> : null}
      {!checkout.isMain && !checkout.managed ? (
        <Badge label={t("sidebar.repoTree.external")} />
      ) : null}
      {checkout.workspaceKeys.length > 0 ? (
        <Text style={styles.count}>{checkout.workspaceKeys.length}</Text>
      ) : null}
    </PressHighlight>
  );
}

function OtherWorkspacesRow(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID="sidebar-repo-tree-other">
      <View style={styles.iconSlot} />
      <Text style={styles.checkoutLabel} numberOfLines={1}>
        {t("sidebar.repoTree.otherWorkspaces")}
      </Text>
    </View>
  );
}

function Badge({ label }: { label: string }): ReactElement {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function rowStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.row,
    sidebarWorkspaceRowStyles.rowIndented,
    hovered && !pressed && styles.rowHovered,
    pressed && styles.rowPressed,
  ];
}

function checkoutRowStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [
    styles.row,
    styles.checkoutIndent,
    hovered && !pressed && styles.rowHovered,
    pressed && styles.rowPressed,
  ];
}

const styles = StyleSheet.create((theme) => ({
  // Kept in step with `workspaceRow` in sidebar-workspace-list.tsx.
  row: {
    minHeight: density.rowHeight,
    marginBottom: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  checkoutIndent: {
    paddingLeft: theme.spacing[2] + theme.spacing[4],
  },
  workspaceIndent: {
    paddingLeft: theme.spacing[4],
  },
  iconSlot: {
    width: densityIconBox("md"),
    height: densityIconBox("md"),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  repoName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    minWidth: 0,
    flexShrink: 1,
  },
  checkoutLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    minWidth: 0,
    flexShrink: 1,
  },
  count: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: "auto",
  },
  badge: {
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  badgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 14,
  },
}));
