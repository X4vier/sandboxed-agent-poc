export function renderLayout(root: HTMLElement): void {
  root.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="seal">Sandboxed</span>
        <h1>In-memory agent workspace</h1>
      </div>
      <div class="topbar-right">
        <div class="debug-log" id="debug-log" hidden>
          <span id="debug-log-label"></span>
          <button id="debug-log-stop" title="Stop debug logging">Stop logging</button>
        </div>
        <div class="tokens" id="tokens">tokens: —</div>
        <button id="open-audit" class="ghost" title="Show the live security audit">🔒 Audit</button>
        <button id="change-key" class="ghost" title="Change API key">🔑 Change key</button>
      </div>
    </header>
    <main class="columns">
      <section class="col">
        <h2>Staged files <span class="count" id="staged-count"></span></h2>
        <div class="col-scroll" id="staged"></div>
        <div class="task-area">
          <button id="add">Add files…</button>
          <textarea id="task" placeholder="Describe the task for the agent…"></textarea>
          <div class="task-buttons">
            <button id="run" class="primary">Run</button>
            <button id="cancel" class="danger" disabled>Cancel</button>
            <button id="new-chat" hidden>New chat</button>
          </div>
        </div>
      </section>
      <section class="col">
        <h2>Transcript</h2>
        <div class="todos" id="todos" hidden></div>
        <div class="col-scroll" id="transcript">
          <div class="idle-hint">Stage files, describe a task, and press Run.</div>
        </div>
      </section>
      <section class="col">
        <h2>Workspace</h2>
        <div class="toolbar">
          <button id="save-all" disabled>Save all…</button>
        </div>
        <div class="col-scroll" id="workspace"><div class="empty">No files yet.</div></div>
        <div class="viewer" id="viewer" hidden>
          <div class="viewer-head">
            <span class="path" id="viewer-path"></span>
            <button id="save-file">Save file…</button>
          </div>
          <pre id="viewer-body"></pre>
        </div>
      </section>
    </main>
    <div class="toast" id="toast"></div>
    <div class="audit" id="audit" hidden>
      <div class="audit-card">
        <div class="audit-head">
          <h2>Live security audit</h2>
          <button id="audit-close" class="ghost" title="Close">✕ Close</button>
        </div>
        <p class="audit-intro">
          A live view of what this process is doing right now — refreshed while
          this panel is open. Everything below is measured from the running app.
          For an <em>independent</em> check, run the OS-level recipe in the
          README's “Verify it yourself” section and confirm it agrees.
        </p>
        <div class="audit-body" id="audit-body"></div>
      </div>
    </div>
    <div class="gate" id="gate" hidden>
      <form class="gate-card" id="gate-form">
        <h2>Enter your Anthropic API key</h2>
        <p>
          The key is held in memory for this session only — it is never written to
          disk and is discarded when you close the app.
        </p>
        <input
          type="password"
          id="api-key"
          placeholder="sk-ant-…"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="gate-error" id="gate-error" hidden></div>
        <button type="submit" class="primary">Continue</button>
      </form>
    </div>
  `;
}
