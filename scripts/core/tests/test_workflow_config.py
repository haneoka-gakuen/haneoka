import re
import unittest
from pathlib import Path


WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def workflow_jobs(filename):
    text = (WORKFLOWS / filename).read_text("utf-8").split("\njobs:\n", 1)[1]
    matches = list(re.finditer(r"^  ([a-z_]+):\s*$", text, re.MULTILINE))
    return {match.group(1): text[match.end():matches[i + 1].start() if i + 1 < len(matches) else len(text)]
            for i, match in enumerate(matches)}


class WorkflowConfigurationTests(unittest.TestCase):
    def test_every_resource_build_job_receives_its_environment_secret(self):
        jobs = workflow_jobs("resource-pipeline-run.yml")
        consumers = {name: body for name, body in jobs.items()
                     if "uses: ./.github/actions/setup-resource-pipeline" in body}
        self.assertEqual(set(consumers), {"prepare", "unity", "release"})
        for name, body in consumers.items():
            with self.subTest(job=name):
                self.assertIn("environment:\n      name: ${{ inputs.github_environment }}", body)
                self.assertIn("RESOURCE_PIPELINE_CONFIG: ${{ secrets.RESOURCE_PIPELINE_CONFIG }}", body)

    def test_reusable_workflow_calls_forward_configuration(self):
        for filename in ("resource-pipeline.yml", "resource-pipeline-run.yml"):
            for name, body in workflow_jobs(filename).items():
                if "uses: ./.github/workflows/" in body:
                    with self.subTest(workflow=filename, job=name):
                        self.assertIn("RESOURCE_PIPELINE_CONFIG: ${{ secrets.RESOURCE_PIPELINE_CONFIG }}", body)
