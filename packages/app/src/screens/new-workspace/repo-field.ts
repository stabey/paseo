import { useCallback, useRef, useState } from "react";
import type { View } from "react-native";
import type { ProjectRepoPayload } from "@getpaseo/protocol/messages";
import type { HostProjectListItem } from "@/projects/host-projects";
import type { NewWorkspaceFormProps } from "./form";
import { useNewWorkspaceRepoPicker } from "./repo-picker";

/**
 * The Repository field of the New workspace form: the picker's state plus the open/anchor
 * plumbing every field carries, packaged so the screen adds one hook call rather than a block.
 *
 * The field shows only when there is a choice to make, or when the project folder is not itself
 * a git checkout and the repository is the one fact that explains where the workspace goes.
 */
export function useNewWorkspaceRepoField(input: {
  selectedServerId: string;
  selectedProject: HostProjectListItem | null;
  preferredDirectory: string | null | undefined;
}): {
  formProps: NewWorkspaceFormProps["repo"];
  /** Main checkout of the chosen repository; null when the project reports no repositories. */
  sourceDirectory: string | null;
  selectedRepo: ProjectRepoPayload | null;
  hasRepos: boolean;
} {
  const picker = useNewWorkspaceRepoPicker(input);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View>(null);
  const openPicker = useCallback(() => setOpen(true), []);
  const onOpenChange = useCallback((nextOpen: boolean) => setOpen(nextOpen), []);
  const selectOption = picker.handleSelectRepoOption;
  const onSelect = useCallback(
    (id: string) => {
      selectOption(id);
      setOpen(false);
    },
    [selectOption],
  );
  const visible =
    picker.hasRepos &&
    (picker.repoOptions.length > 1 || input.selectedProject?.projectKind !== "git");

  return {
    formProps: {
      anchorRef,
      open: openPicker,
      openState: open,
      onOpenChange,
      visible,
      options: picker.repoOptions,
      selectedOptionId: picker.selectedRepoOptionId,
      triggerLabel: picker.triggerLabel,
      onSelect,
    },
    sourceDirectory: picker.sourceDirectory,
    selectedRepo: picker.selectedRepo,
    hasRepos: picker.hasRepos,
  };
}
