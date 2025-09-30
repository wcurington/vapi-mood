📑 VERSIONING.md
Purpose

This document explains how we track versions across the Health America AI backend.
Files, Docker images, and Git tags must stay aligned for clarity, rollbacks, and audits.

1. package.json

File name never changes.

Version is managed with the "version" field.

Example:

{
  "name": "vapi-render-webhook",
  "version": "2.5.1"
}

2. Core Code Files

Versioned in the filename to support multiple side-by-side builds.

Examples:

server_v2.5.1.js

integrations_v1.8.0.js

build_flow_v2.1.0.js

Rule: bump the filename version only when behavior changes (logic, API contracts, flow handling).

Old versions can be kept for rollback or testing.

3. Documents & Checklists

PDFs/Markdowns are versioned in the filename (e.g., Alex_Agent_Testing_Checklist_v2.2.pdf).

Rule: never overwrite old versions — create a new numbered file.

Ensures audit trail for QA and compliance.

4. Docker Images

Images are tagged with the same version as the main server file.

Example:

docker build -t healthamerica/app:2.5.1 .
docker run healthamerica/app:2.5.1

5. Git Tagging

Every release should be tagged in Git so code history, Docker images, and docs line up.

Workflow

Commit your changes

git add .
git commit -m "Release v2.5.1"


Create a version tag

git tag v2.5.1


Push tags to remote

git push origin main --tags

Benefits

git checkout v2.5.1 instantly restores the code as deployed.

Docker images and Git tags share the same version number.

Easier rollback and QA validation.

6. General Rules

package.json → semantic version bump inside only.

.js code files → filename version bump.

Docs → filename version bump.

Docker images → tag aligned with server version.

Git → create annotated tags for each release.

✅ Visual Summary

Artifact	How versioned?	Example
package.json	"version": "2.5.1"	stays package.json
JS code files	filename suffix	server_v2.5.1.js
Docs (PDF/MD)	filename suffix	QA_Checklist_v2.2.pdf
Docker images	tag	healthamerica/app:2.5.1
Git repo	annotated tag	git tag v2.5.1