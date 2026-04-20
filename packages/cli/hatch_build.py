from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import tarfile

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

LOCAL_UI_ARCHIVE_RELATIVE_PATH = Path("src") / "agentreview" / "local_ui_assets.tar.gz"


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        archive_path = Path(self.root) / LOCAL_UI_ARCHIVE_RELATIVE_PATH
        self._generated_archive = False

        workspace_root = _find_workspace_root(Path(self.root))
        if workspace_root is not None and shutil.which("pnpm") is not None:
            _build_local_ui_archive(workspace_root, archive_path)
            self._generated_archive = True
        elif not archive_path.is_file():
            raise RuntimeError(
                "Bundled local UI assets are missing. Build from the full agentreview repository or install a prebuilt distribution."
            )

        target_path = (
            f"agentreview/{LOCAL_UI_ARCHIVE_RELATIVE_PATH.name}"
            if self.target_name == "wheel"
            else LOCAL_UI_ARCHIVE_RELATIVE_PATH.as_posix()
        )
        build_data.setdefault("force-include", {})[str(archive_path)] = target_path

    def finalize(self, version: str, build_data: dict, artifact_path: str) -> None:
        if not self._generated_archive:
            return

        archive_path = Path(self.root) / LOCAL_UI_ARCHIVE_RELATIVE_PATH
        archive_path.unlink(missing_ok=True)


def _find_workspace_root(project_root: Path) -> Path | None:
    for parent in project_root.resolve().parents:
        if (parent / "pnpm-workspace.yaml").is_file() and (
            parent / "packages" / "web" / "package.json"
        ).is_file():
            return parent
    return None


def _build_local_ui_archive(workspace_root: Path, archive_path: Path) -> None:
    web_dir = workspace_root / "packages" / "web"
    shutil.rmtree(web_dir / ".next", ignore_errors=True)
    shutil.rmtree(web_dir / "out", ignore_errors=True)
    subprocess.run(
        ["pnpm", "--dir", str(workspace_root), "--filter", "@agentreview/web", "build"],
        check=True,
    )

    out_dir = web_dir / "out"
    if not out_dir.is_dir():
        raise RuntimeError(f"Expected static export output at {out_dir}.")

    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(out_dir, arcname="site")
