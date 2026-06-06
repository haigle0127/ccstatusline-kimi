import * as vscode from 'vscode';
import * as path from 'path';

export interface GitInfo {
    branch?: string;
    ahead?: number;
    behind?: number;
    changes?: number;
    insertions?: number;
    deletions?: number;
    staged?: number;
    unstaged?: number;
    untracked?: number;
    conflicts?: number;
    isClean?: boolean;
}

export async function getGitInfo(workspaceFolder?: string): Promise<GitInfo> {
    try {
        const gitExtension = vscode.extensions.getExtension('vscode.git');
        if (!gitExtension) {
            return {};
        }

        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }

        const git = gitExtension.exports?.getAPI?.(1);
        if (!git) {
            return {};
        }

        const repos = git.repositories as Array<{
            rootUri: vscode.Uri;
            state?: {
                HEAD?: { name?: string; ahead?: number; behind?: number };
                workingTreeChanges?: Array<{ status: number }>;
                indexChanges?: Array<{ status: number }>;
                mergeChanges?: Array<{ status: number }>;
                untrackedChanges?: unknown[];
            };
        }>;

        if (!Array.isArray(repos) || repos.length === 0) {
            return {};
        }

        let repo = repos[0];

        if (workspaceFolder) {
            const target = path.normalize(workspaceFolder).toLowerCase().replace(/\\/g, '/');
            const match = repos.find(r => {
                if (!r?.rootUri?.fsPath) {
                    return false;
                }
                const repoPath = path.normalize(r.rootUri.fsPath).toLowerCase().replace(/\\/g, '/');
                return target === repoPath || target.startsWith(repoPath + '/');
            });
            if (match) {
                repo = match;
            }
        }

        const state = repo.state ?? {};
        const head = state.HEAD;

        const workingTree = Array.isArray(state.workingTreeChanges) ? state.workingTreeChanges : [];
        const index = Array.isArray(state.indexChanges) ? state.indexChanges : [];
        const merge = Array.isArray(state.mergeChanges) ? state.mergeChanges : [];
        const untracked = Array.isArray(state.untrackedChanges) ? state.untrackedChanges : [];

        const isClean = workingTree.length === 0 && index.length === 0 && merge.length === 0 && untracked.length === 0;

        return {
            branch: head?.name,
            ahead: typeof head?.ahead === 'number' ? head.ahead : 0,
            behind: typeof head?.behind === 'number' ? head.behind : 0,
            changes: workingTree.length + index.length + merge.length,
            staged: index.length,
            unstaged: workingTree.length,
            untracked: untracked.length,
            conflicts: merge.length,
            isClean
        };
    } catch (err) {
        console.error('[ccstatusline] git error:', err);
        return {};
    }
}
