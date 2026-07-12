import assert from "node:assert/strict";
import { mkdir, writeFile, rm, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { createSkillControlServer } from "../scripts/lib/server-app.mjs";

const STATUSES = ["update_available", "up_to_date", "not_checkable", "unknown", "error"];

function registrySkill({ id, name, path, route, source, status, index, scope }) {
  const now = "2026-07-10T00:00:00.000Z";
  return {
    id,
    name,
    lifecycle: "active",
    ownership: "managed",
    capability_summary: `Detailed capability ${index}: cleans, validates, and routes agent context with deterministic safeguards.`,
    scope: scope || { level: "public", agent: null, project_root: null },
    install: { canonical_path: path, skill_md_path: join(path, "SKILL.md"), routes: route ? [route] : [] },
    source: {
      type: source?.type || "local",
      url: source?.url || null,
      repository: source?.repository || null,
      subpath: null,
      ref: null,
      revision: source?.revision || null,
      content_digest: null,
    },
    version: { current: `1.${index}.0`, kind: "semver", basis: "frontmatter" },
    update: {
      status,
      latest: status === "update_available" ? "2.0.0" : null,
      checked_at: status === "unknown" ? null : now,
      error: status === "error" ? "remote unavailable" : null,
    },
    installed_at: now,
    updated_at: now,
  };
}

async function withMockServer(fn) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skill-control-panel-ui-v2-"));
  const registryPath = join(tempRoot, "skills-registry.yaml");
  const historyPath = join(tempRoot, "skills-history.jsonl");
  const publicRoot = join(tempRoot, "public");
  const routeRoot = join(tempRoot, "routes");
  const projectRoot = join(tempRoot, "fixture-project");
  await mkdir(publicRoot, { recursive: true });
  await mkdir(routeRoot, { recursive: true });

  const sources = [
    { type: "github", url: "https://github.com/owner/defuddle" },
    { type: "github", repository: "https://github.com/owner/repository-only" },
    null,
    { type: "git", url: "https://git.example.test/unknown-skill" },
    { type: "git", repository: "https://git.example.test/error-skill" },
  ];
  const skills = [];
  for (let index = 0; index < STATUSES.length; index += 1) {
    const name = index === 0 ? "defuddle" : `fixture-skill-${index}`;
    const path = join(publicRoot, name);
    const route = index === 0 ? join(routeRoot, name) : null;
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${name}\nversion: 1.${index}.0\n---\n\nFull document for ${name}.\n`,
      "utf8",
    );
    if (route) await symlink(path, route);
    skills.push(registrySkill({
      id: `skill-${name}`,
      name,
      path,
      route,
      source: sources[index],
      status: STATUSES[index],
      index,
    }));
  }
  const projectDefuddle = join(projectRoot, ".agents", "skills", "defuddle");
  await mkdir(projectDefuddle, { recursive: true });
  await writeFile(join(projectDefuddle, "SKILL.md"), "---\nname: defuddle\nversion: 1.9.0\n---\n\nProject document for defuddle.\n", "utf8");
  skills.push(registrySkill({
    id: "skill-defuddle-project",
    name: "defuddle",
    path: projectDefuddle,
    source: sources[0],
    status: "not_checkable",
    index: 9,
    scope: { level: "project", agent: null, project_root: projectRoot },
  }));

  await writeFile(registryPath, JSON.stringify({
    schemaVersion: 1,
    updatedAt: "2026-07-10T00:00:00.000Z",
    skills,
  }), "utf8");
  await writeFile(historyPath, `${JSON.stringify({
    schemaVersion: 1,
    id: "evt-123",
    timestamp: "2026-07-10T00:00:00.000Z",
    actor: { agent: "claude", sessionId: "session-1" },
    skillId: "skill-defuddle",
    skillName: "defuddle",
    action: "install",
    before: null,
    after: null,
    affectedPaths: [join(publicRoot, "defuddle")],
    result: "success",
    error: null,
  })}\n`, "utf8");

  const app = createSkillControlServer({
    hubRoot: false,
    registryPath,
    historyPath,
    roots: {
      public: [{ path: publicRoot, agents: [], ownership: "managed" }],
      agent: [], project: [{ path: join(projectRoot, ".agents", "skills"), projectRoot, agents: [], ownership: "managed" }], system: [], plugin: [],
    },
  });
  await app.refreshSnapshot();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

  try {
    await fn({ baseUrl, skills });
  } finally {
    await new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runUiSelfTest() {
  const browser = await chromium.launch({ headless: true });
  try {
    await withMockServer(async ({ baseUrl, skills }) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        permissions: ["clipboard-read", "clipboard-write"],
      });
      const page = await context.newPage();
      const writeRequests = [];
      page.on("request", (request) => {
        if (request.method() !== "GET") writeRequests.push(`${request.method()} ${request.url()}`);
      });
      let delayNextDetail = false;
      await page.route("**/api/skills/*", async (route) => {
        const response = await route.fetch();
        if (delayNextDetail) {
          delayNextDetail = false;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        await route.fulfill({ response });
      });

      await page.goto(baseUrl, { waitUntil: "networkidle" });
      const auditDir = process.env.UI_AUDIT_DIR || null;
      if (auditDir) await mkdir(auditDir, { recursive: true });
      assert.equal(await page.locator(".metric-card").count(), 2);
      assert.deepEqual(await page.locator(".metric-label").allTextContents(), ["总 Skill 数", "有更新数"]);
      assert.deepEqual(await page.locator(".scope-metric-label").allTextContents(), ["Hub", "公共", "Agent", "项目"]);
      assert.deepEqual(await page.locator(".scope-metric-card strong").allTextContents(), ["0", "5", "0", "1"]);
      assert.equal(await page.locator(".inventory-table thead th").count(), 7);
      assert.equal(await page.locator(".column-resizer").count(), 6);
      const projectHeading = page.locator(".inventory-table thead th").nth(3);
      const defaultProjectWidth = (await projectHeading.boundingBox()).width;
      assert.ok(defaultProjectWidth >= 110);
      const projectResizer = page.locator('.column-resizer[data-column="project"]');
      const handle = await projectResizer.boundingBox();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2);
      await page.mouse.up();
      assert.ok((await projectHeading.boundingBox()).width > defaultProjectWidth + 30);
      assert.ok(await page.locator(".table-frame").evaluate((element) => element.scrollWidth > element.clientWidth));
      await page.reload({ waitUntil: "networkidle" });
      assert.ok(Math.abs((await projectHeading.boundingBox()).width - defaultProjectWidth) < 2);
      assert.equal(await page.locator(".nav-link").count(), 6);
      const sidebarToggle = page.getByRole("button", { name: "折叠侧栏" });
      assert.equal(await sidebarToggle.getAttribute("aria-expanded"), "true");
      const expandedWidth = (await page.locator(".sidebar").boundingBox()).width;
      await sidebarToggle.click();
      await page.waitForTimeout(220);
      assert.equal(await page.locator(".app-shell").getAttribute("data-sidebar-collapsed"), "true");
      assert.ok((await page.locator(".sidebar").boundingBox()).width < expandedWidth - 100);
      assert.equal(await page.locator(".nav-label").first().isVisible(), false);
      assert.equal(await page.getByRole("button", { name: "全部 Skill" }).getAttribute("title"), "全部 Skill");
      assert.equal(await page.getByRole("button", { name: "更新中心" }).count(), 1);
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(await page.getByRole("button", { name: "折叠侧栏" }).getAttribute("aria-expanded"), "true");
      assert.equal(await page.getByLabel("类型").count(), 1);
      await page.getByLabel("类型").selectOption("public_shared");
      assert.ok(await page.locator(".shared-chip").count());
      await page.getByRole("button", { name: "清除筛选" }).click();

      assert.equal(await page.locator('a[href="https://github.com/owner/defuddle"]').count(), 1);
      assert.equal(await page.locator('a[href="https://github.com/owner/repository-only"]').count(), 1);
      assert.ok((await page.locator(".source-cell").allTextContents()).includes("--"));
      assert.deepEqual(
        new Set(await page.locator("[data-update-status]").allTextContents()),
        new Set(["有更新", "已是最新", "不可检查", "未检查", "检查失败"]),
      );

      await page.getByLabel("搜索 Skill").fill("fixture-project");
      assert.deepEqual(await page.locator(".skill-name").allTextContents(), ["defuddle"]);
      await page.getByLabel("层级", { exact: true }).selectOption("project");
      assert.equal(await page.locator(".inventory-row").count(), 1);
      assert.equal(await page.locator('[data-scope="public"]').count(), 1);
      assert.equal(await page.locator('[data-scope="project"]').count(), 1);
      assert.ok(await page.locator(".shared-chip").count());
      await page.getByRole("button", { name: "清除筛选" }).click();
      assert.equal(await page.locator(".inventory-row").count(), 5);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0);
      await page.setViewportSize({ width: 1117, height: 837 });
      const projectBox1117 = await page.locator(".inventory-table thead th").nth(3).boundingBox();
      const agentsBox1117 = await page.locator(".inventory-table thead th").nth(4).boundingBox();
      assert.ok(projectBox1117.width >= 110);
      assert.ok(projectBox1117.x + projectBox1117.width <= agentsBox1117.x + 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
      await page.setViewportSize({ width: 1280, height: 800 });
      if (auditDir) await page.screenshot({ path: join(auditDir, "inventory-1280x800.png"), fullPage: true });
      const tooltip = page.locator(".capability-trigger").first();
      await tooltip.focus();
      assert.equal(await tooltip.getAttribute("tabindex"), "0");
      assert.ok(await tooltip.getAttribute("aria-label"));
      assert.equal(await tooltip.evaluate((element) => getComputedStyle(element).webkitLineClamp), "3");
      assert.equal(await tooltip.evaluate((element) => getComputedStyle(element).webkitBoxOrient), "vertical");
      assert.equal(await tooltip.evaluate((element) => getComputedStyle(element).whiteSpace), "normal");
      const capabilityBox = await tooltip.boundingBox();
      await tooltip.hover({ position: { x: 5, y: 6 } });
      const floatingTooltip = page.locator(".inventory-tooltip");
      await floatingTooltip.waitFor({ timeout: 1000 });
      assert.equal(await floatingTooltip.textContent(), await tooltip.textContent());
      assert.ok(Math.abs(parseFloat(await floatingTooltip.evaluate((element) => getComputedStyle(element).left)) - (capabilityBox.x + 19)) < 1);

      const projectPath = page.locator(".project-path-cell").filter({ hasText: "fixture-project" }).first();
      const projectPathBox = await projectPath.boundingBox();
      await projectPath.hover({ position: { x: 5, y: 6 } });
      assert.equal(await projectPath.getAttribute("tabindex"), "0");
      assert.match(await floatingTooltip.textContent(), /fixture-project/);
      assert.ok(Math.abs(parseFloat(await floatingTooltip.evaluate((element) => getComputedStyle(element).left)) - (projectPathBox.x + 19)) < 1);

      const sourceLink = page.locator(".source-cell a").first();
      const sourceBox = await sourceLink.boundingBox();
      await sourceLink.hover({ position: { x: 5, y: 6 } });
      assert.equal(await floatingTooltip.textContent(), await sourceLink.getAttribute("href"));
      assert.ok(Math.abs(parseFloat(await floatingTooltip.evaluate((element) => getComputedStyle(element).left)) - Math.min(sourceBox.x + 19, 820)) < 1);

      const firstRow = page.locator(".inventory-row").first();
      await firstRow.focus();
      await firstRow.press("Enter");
      const dialog = page.getByRole("dialog", { name: /defuddle/ });
      await dialog.waitFor();
      assert.equal(await dialog.getAttribute("aria-modal"), null);
      assert.equal(await page.locator(".drawer-overlay").evaluate((element) => getComputedStyle(element).pointerEvents), "none");
      assert.equal(await page.locator(":focus").getAttribute("aria-label"), "关闭详情");
      assert.ok(await dialog.getByText("暴露路由").count());
      assert.ok(await dialog.getByText("检查时间").count());
      assert.ok(await dialog.getByText("有更新", { exact: true }).count());
      assert.ok(await dialog.getByText("2 个安装实例").count());
      assert.equal(await dialog.locator("[data-instance-id]").count(), 2);
      await dialog.getByLabel("SKILL.md 安装实例").selectOption("skill-defuddle-project");
      assert.ok(await dialog.locator(".skill-md-source").textContent().then((text) => text.includes("Project document for defuddle")));

      await dialog.getByRole("button", { name: "复制名称" }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "defuddle");
      await dialog.getByRole("button", { name: "复制安装路径" }).first().click();
      assert.ok((await page.evaluate(() => navigator.clipboard.readText())).endsWith("/public/defuddle"));
      await dialog.getByRole("button", { name: "复制当前 SKILL.md" }).click();
      assert.ok(await page.evaluate(() => navigator.clipboard.readText()).then((text) => text.includes("Project document for defuddle")));
      if (auditDir) {
        await page.setViewportSize({ width: 1440, height: 1024 });
        await page.screenshot({ path: join(auditDir, "detail-drawer-1440x1024.png"), fullPage: true });
      }

      const secondRow = page.locator(".inventory-row").nth(1);
      delayNextDetail = true;
      await secondRow.locator(".skill-name").click();
      const currentDialog = page.getByRole("dialog");
      await currentDialog.getByRole("heading", { name: "fixture-skill-1" }).waitFor({ timeout: 150 });
      assert.equal(await secondRow.getAttribute("data-detail-trigger"), "true");
      await page.getByRole("heading", { name: "全部 Skill 库存" }).click();
      await currentDialog.waitFor({ state: "detached" });
      assert.equal(await secondRow.evaluate((element) => document.activeElement === element), true);
      await page.setViewportSize({ width: 1440, height: 1024 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
      if (process.env.UI_SCREENSHOT) await page.screenshot({ path: process.env.UI_SCREENSHOT, fullPage: true });
      if (auditDir) await page.screenshot({ path: join(auditDir, "inventory-1440x1024.png"), fullPage: true });

      const expectedViews = [
        ["更新中心", "可用更新", "updates.png"],
        ["环境诊断", "环境诊断", "diagnostics.png"],
        ["操作历史", "操作历史", "history.png"],
        ["管理规范", "管理规范", "governance.png"],
        ["项目路径", "项目路径", "projects.png"],
        ["全部 Skill", "全部 Skill 库存", null],
      ];
      for (const [nav, heading, screenshot] of expectedViews) {
        await page.locator(".nav-link", { hasText: nav }).click();
        await page.getByRole("heading", { name: heading }).waitFor();
        if (auditDir && screenshot) await page.screenshot({ path: join(auditDir, screenshot), fullPage: true });
      }

      await page.locator(".nav-link", { hasText: "管理规范" }).click();
      const governanceText = await page.locator(".governance-docs").textContent();
      assert.match(governanceText, /install .*--source <path> .*--scope public .*--vetted/);
      assert.match(governanceText, /update .*--skill <id> .*--source <path> .*--vetted/);
      assert.match(governanceText, /move .*--skill <id> .*--scope project .*--project-root <absolute-path> .*--confirmed/);
      assert.match(governanceText, /uninstall .*--skill <id> .*--confirmed/);
      assert.match(governanceText, /Hub 更新后的固定动作/);
      assert.match(governanceText, /private-skill-hub\.mjs --apply --confirmed/);

      assert.equal(writeRequests.length, 0);
      assert.equal(await page.getByRole("button", { name: /安装|更新 Skill|移动 Skill|卸载|删除/ }).count(), 0);
      await context.close();
      console.log("UI Playwright self-test passed");
    });
  } finally {
    await browser.close();
  }
}

runUiSelfTest().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
