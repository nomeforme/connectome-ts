/**
 * Text Editor Control Panel
 * 
 * Provides file system viewing and editing capabilities to agents,
 * matching the Anthropic text editor tool interface for familiarity.
 * 
 * Features:
 * - view/view_range: View file contents with line numbers
 * - create: Create new files
 * - str_replace: Replace unique text occurrences
 * - insert: Insert text at specific lines
 * - undo: Revert recent edits (per-file history)
 * - setWorkingDirectory: Change focus path
 * 
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
 */

import * as fs from 'fs';
import * as path from 'path';
import { ControlPanelComponent } from './control-panel';
import { persistent } from '../persistence/decorators';

/**
 * Backup entry for undo functionality
 */
interface BackupEntry {
  originalPath: string;
  backupPath: string;
  timestamp: number;
  operation: 'str_replace' | 'insert' | 'create';
  description: string;
}

/**
 * Configuration options for the text editor panel
 */
export interface TextEditorPanelConfig {
  /** Initial working directory (defaults to process.cwd()) */
  workingDirectory?: string;
  /** Maximum characters to show in view (default: 50000) */
  maxViewCharacters?: number;
  /** Maximum backup entries per file (default: 5) */
  maxBackupsPerFile?: number;
  /** Backup directory (default: /tmp/connectome-text-editor-{timestamp}) */
  backupDirectory?: string;
}

/**
 * Text Editor Control Panel Component
 * 
 * A collapsible control panel providing file editing capabilities.
 * Tools are scoped to the panel and hidden when closed.
 */
export class TextEditorControlPanel extends ControlPanelComponent {
  // Panel identity
  protected getPanelId(): string { return 'text-editor'; }
  protected getPanelDisplayName(): string { return 'Text Editor'; }

  // Configuration
  private config: Required<TextEditorPanelConfig>;

  // Persistent state
  @persistent()
  private workingDirectory: string;

  @persistent()
  private recentFiles: string[] = [];

  // Runtime state (not persisted)
  private editHistory: Map<string, BackupEntry[]> = new Map();
  private backupDir: string;
  private sessionId: string;

  constructor(config: TextEditorPanelConfig = {}) {
    super();
    
    this.config = {
      workingDirectory: config.workingDirectory || process.cwd(),
      maxViewCharacters: config.maxViewCharacters || 50000,
      maxBackupsPerFile: config.maxBackupsPerFile || 5,
      backupDirectory: config.backupDirectory || `/tmp/connectome-text-editor-${Date.now()}`
    };
    
    this.workingDirectory = this.config.workingDirectory;
    this.sessionId = `session-${Date.now()}`;
    this.backupDir = this.config.backupDirectory;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  protected async onPanelOpened(): Promise<void> {
    console.log(`[TextEditor] Panel opened. Working directory: ${this.workingDirectory}`);
    
    // Ensure backup directory exists
    await this.ensureBackupDir();
    
    // Show current state
    this.addEvent(
      `Text Editor ready.\nWorking directory: ${this.workingDirectory}\nRecent files: ${this.recentFiles.length}`,
      'panel-ready',
      `text-editor-ready-${Date.now()}`
    );
  }

  protected async onPanelClosed(): Promise<void> {
    console.log('[TextEditor] Panel closed');
  }

  async onMount(): Promise<void> {
    console.log('[TextEditor] Component mounting...');
    await super.onMount();

    // ─────────────────────────────────────────────────────────────────────────
    // View Tools
    // ─────────────────────────────────────────────────────────────────────────

    this.registerPanelTool(
      'view',
      async (params) => await this.handleView(params),
      `To view a file's contents or list a directory:
{@text-editor.view(path="./src/index.ts")}
{@text-editor.view(path="./src")}

Returns file contents with line numbers, or directory listing.`,
      {
        description: 'View file contents with line numbers, or list directory contents',
        params: {
          path: { type: 'string', required: true, description: 'File or directory path (relative to working directory or absolute)' }
        }
      }
    );

    this.registerPanelTool(
      'view_range',
      async (params) => await this.handleViewRange(params),
      `To view specific lines of a file:
{@text-editor.view_range(path="./src/index.ts", startLine=100, endLine=150)}

Useful for large files or focusing on specific sections.`,
      {
        description: 'View specific line range of a file',
        params: {
          path: { type: 'string', required: true },
          startLine: { type: 'number', required: true, description: 'First line to show (1-based)' },
          endLine: { type: 'number', required: true, description: 'Last line to show (1-based)' }
        }
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Edit Tools
    // ─────────────────────────────────────────────────────────────────────────

    this.registerPanelTool(
      'create',
      async (params) => await this.handleCreate(params),
      `To create a new file:
{@text-editor.create(path="./src/new-file.ts", content="// New file\\nexport {};")}

Fails if file already exists. Use str_replace to modify existing files.`,
      {
        description: 'Create a new file with the given content',
        params: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true, description: 'File content to write' }
        }
      }
    );

    this.registerPanelTool(
      'str_replace',
      async (params) => await this.handleStrReplace(params),
      `To replace text in a file (must match exactly once):
{@text-editor.str_replace(path="./src/app.ts", old_str="console.log('debug');", new_str="// debug removed")}

The old_str must appear exactly once in the file. Include surrounding context if needed for uniqueness.`,
      {
        description: 'Replace a unique text occurrence in a file',
        params: {
          path: { type: 'string', required: true },
          old_str: { type: 'string', required: true, description: 'Text to find (must be unique)' },
          new_str: { type: 'string', required: true, description: 'Replacement text' }
        }
      }
    );

    this.registerPanelTool(
      'insert',
      async (params) => await this.handleInsert(params),
      `To insert text at a specific line:
{@text-editor.insert(path="./src/app.ts", insert_line=10, new_str="// Inserted comment")}

Inserts the new text AFTER the specified line number. Use insert_line=0 to insert at the beginning.`,
      {
        description: 'Insert text after a specific line',
        params: {
          path: { type: 'string', required: true },
          insert_line: { type: 'number', required: true, description: 'Line number to insert after (0 for beginning)' },
          new_str: { type: 'string', required: true, description: 'Text to insert' }
        }
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Undo Tool
    // ─────────────────────────────────────────────────────────────────────────

    this.registerPanelTool(
      'undo',
      async (params) => await this.handleUndo(params),
      `To undo the last edit to a file:
{@text-editor.undo(path="./src/app.ts")}

Reverts the most recent str_replace, insert, or create operation on that file.`,
      {
        description: 'Undo the last edit operation on a file',
        params: {
          path: { type: 'string', required: true, description: 'File to undo changes on' }
        }
      }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Navigation Tools
    // ─────────────────────────────────────────────────────────────────────────

    this.registerPanelTool(
      'setWorkingDirectory',
      async (params) => await this.handleSetWorkingDirectory(params),
      `To change the working directory (focus):
{@text-editor.setWorkingDirectory(path="/home/user/project")}

Relative paths will resolve from this directory.`,
      {
        description: 'Change the working directory for relative path resolution',
        params: {
          path: { type: 'string', required: true, description: 'New working directory' }
        }
      }
    );

    this.registerPanelTool(
      'listRecentFiles',
      async () => await this.handleListRecentFiles(),
      `To see recently edited files:
{@text-editor.listRecentFiles()}`,
      {
        description: 'List recently viewed/edited files'
      }
    );

    console.log('[TextEditor] Component mounted with all tools registered');
    
    // Emit tools-registered event for receptors to create facets
    await this.onMountComplete();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Path Resolution & Validation
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a path relative to working directory
   */
  private resolvePath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return path.normalize(inputPath);
    }
    return path.normalize(path.join(this.workingDirectory, inputPath));
  }

  /**
   * Check if content appears to be binary
   */
  private isBinaryContent(buffer: Buffer): boolean {
    // Check first 8KB for null bytes
    const sample = buffer.slice(0, 8192);
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) return true;
    }
    return false;
  }

  /**
   * Add a file to recent files list
   */
  private trackRecentFile(filePath: string): void {
    const normalized = this.resolvePath(filePath);
    // Remove if already present, add to front
    this.recentFiles = [
      normalized,
      ...this.recentFiles.filter(f => f !== normalized)
    ].slice(0, 20); // Keep last 20
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Backup System
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Ensure backup directory exists
   */
  private async ensureBackupDir(): Promise<void> {
    try {
      await fs.promises.mkdir(this.backupDir, { recursive: true });
    } catch (err) {
      console.error('[TextEditor] Failed to create backup directory:', err);
    }
  }

  /**
   * Create a backup of a file before editing
   */
  private async createBackup(
    filePath: string, 
    operation: BackupEntry['operation'],
    description: string
  ): Promise<BackupEntry | null> {
    const resolved = this.resolvePath(filePath);
    
    try {
      // Check if file exists (for create operations, it won't)
      const exists = await fs.promises.access(resolved).then(() => true).catch(() => false);
      
      if (!exists && operation !== 'create') {
        return null;
      }

      const timestamp = Date.now();
      const hash = Buffer.from(resolved).toString('base64').replace(/[/+=]/g, '_').slice(0, 32);
      const backupPath = path.join(this.backupDir, `${hash}_${timestamp}`);

      if (exists) {
        await fs.promises.copyFile(resolved, backupPath);
      } else {
        // For create operations, mark that file didn't exist
        await fs.promises.writeFile(backupPath, '__FILE_DID_NOT_EXIST__');
      }

      const entry: BackupEntry = {
        originalPath: resolved,
        backupPath,
        timestamp,
        operation,
        description
      };

      // Add to history, limit per file
      const history = this.editHistory.get(resolved) || [];
      history.push(entry);
      
      // Keep only last N backups
      while (history.length > this.config.maxBackupsPerFile) {
        const old = history.shift();
        if (old) {
          try {
            await fs.promises.unlink(old.backupPath);
          } catch { /* ignore cleanup errors */ }
        }
      }
      
      this.editHistory.set(resolved, history);
      return entry;
    } catch (err) {
      console.error('[TextEditor] Failed to create backup:', err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle view command - view file or list directory
   */
  private async handleView(params: { path: string }): Promise<void> {
    const targetPath = this.resolvePath(params.path);
    
    try {
      const stat = await fs.promises.stat(targetPath);
      
      if (stat.isDirectory()) {
        await this.viewDirectory(targetPath);
      } else {
        await this.viewFile(targetPath, 1, undefined);
      }
    } catch (err: any) {
      this.emitError(`Cannot view '${params.path}': ${err.message}`);
    }
  }

  /**
   * Handle view_range command - view specific lines
   */
  private async handleViewRange(params: { path: string; startLine: number; endLine: number }): Promise<void> {
    const targetPath = this.resolvePath(params.path);
    
    try {
      await this.viewFile(targetPath, params.startLine, params.endLine);
    } catch (err: any) {
      this.emitError(`Cannot view '${params.path}': ${err.message}`);
    }
  }

  /**
   * View a file with line numbers
   */
  private async viewFile(filePath: string, startLine: number, endLine?: number): Promise<void> {
    const buffer = await fs.promises.readFile(filePath);
    
    // Check for binary
    if (this.isBinaryContent(buffer)) {
      this.emitError(`Cannot view binary file: ${filePath}\nUse a hex editor or specialized tool.`);
      return;
    }

    const content = buffer.toString('utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    // Determine range
    const start = Math.max(1, startLine);
    const end = endLine ? Math.min(endLine, totalLines) : totalLines;
    
    // Get requested lines
    const selectedLines = lines.slice(start - 1, end);
    
    // Add line numbers
    const maxLineNumWidth = String(end).length;
    const numberedLines = selectedLines.map((line, i) => {
      const lineNum = String(start + i).padStart(maxLineNumWidth, ' ');
      return `${lineNum} | ${line}`;
    });

    let output = numberedLines.join('\n');
    let truncated = false;

    // Check total size
    if (output.length > this.config.maxViewCharacters) {
      output = output.slice(0, this.config.maxViewCharacters);
      truncated = true;
    }

    // Track file
    this.trackRecentFile(filePath);

    // Emit result
    const relativePath = path.relative(this.workingDirectory, filePath);
    const displayPath = relativePath.startsWith('..') ? filePath : `./${relativePath}`;
    
    let header = `📄 ${displayPath}`;
    if (endLine) {
      header += ` (lines ${start}-${end} of ${totalLines})`;
    } else {
      header += ` (${totalLines} lines)`;
    }
    if (truncated) {
      header += `\n⚠️ Output truncated at ${this.config.maxViewCharacters} characters. Use view_range for specific sections.`;
    }

    this.addEvent(
      `${header}\n${'─'.repeat(60)}\n${output}`,
      'file-view',
      `text-editor-view-${Date.now()}`,
      { path: filePath, totalLines, startLine: start, endLine: end, truncated }
    );
  }

  /**
   * View directory contents
   */
  private async viewDirectory(dirPath: string): Promise<void> {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    
    const dirs: string[] = [];
    const files: string[] = [];
    
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // Skip hidden files
      if (entry.isDirectory()) {
        dirs.push(`📁 ${entry.name}/`);
      } else {
        files.push(`   ${entry.name}`);
      }
    }

    // Sort and combine
    dirs.sort();
    files.sort();
    const listing = [...dirs, ...files].join('\n');

    const relativePath = path.relative(this.workingDirectory, dirPath);
    const displayPath = relativePath === '' ? '.' : (relativePath.startsWith('..') ? dirPath : `./${relativePath}`);

    this.addEvent(
      `📂 ${displayPath}\n${'─'.repeat(60)}\n${listing || '(empty directory)'}`,
      'directory-view',
      `text-editor-dir-${Date.now()}`,
      { path: dirPath, fileCount: files.length, dirCount: dirs.length }
    );
  }

  /**
   * Handle create command - create new file
   */
  private async handleCreate(params: { path: string; content: string }): Promise<void> {
    const targetPath = this.resolvePath(params.path);
    
    try {
      // Check if exists
      const exists = await fs.promises.access(targetPath).then(() => true).catch(() => false);
      if (exists) {
        this.emitError(`File already exists: ${params.path}\nUse str_replace to modify existing files.`);
        return;
      }

      // Ensure parent directory exists
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

      // Create backup entry (marks file didn't exist)
      await this.createBackup(targetPath, 'create', `Created new file`);

      // Write file
      await fs.promises.writeFile(targetPath, params.content, 'utf-8');

      // Track
      this.trackRecentFile(targetPath);

      const lines = params.content.split('\n').length;
      this.addEvent(
        `✅ Created: ${params.path} (${lines} lines)\n(undo available: {@text-editor.undo(path="${params.path}")})`,
        'file-created',
        `text-editor-create-${Date.now()}`,
        { path: targetPath, lines }
      );
    } catch (err: any) {
      this.emitError(`Failed to create '${params.path}': ${err.message}`);
    }
  }

  /**
   * Handle str_replace command - replace unique text
   */
  private async handleStrReplace(params: { path: string; old_str: string; new_str: string }): Promise<void> {
    const targetPath = this.resolvePath(params.path);
    
    try {
      const buffer = await fs.promises.readFile(targetPath);
      
      if (this.isBinaryContent(buffer)) {
        this.emitError(`Cannot edit binary file: ${params.path}`);
        return;
      }

      const content = buffer.toString('utf-8');
      
      // Count occurrences
      const matches = content.split(params.old_str).length - 1;
      
      if (matches === 0) {
        this.emitError(
          `No match found for the specified text in ${params.path}.\n` +
          `Make sure the text matches exactly, including whitespace and newlines.`
        );
        return;
      }
      
      if (matches > 1) {
        this.emitError(
          `Found ${matches} matches for the specified text in ${params.path}.\n` +
          `Please provide more context to make a unique match.`
        );
        return;
      }

      // Find line number of match for reporting
      const beforeMatch = content.slice(0, content.indexOf(params.old_str));
      const lineNumber = beforeMatch.split('\n').length;

      // Create backup
      const description = `Replaced "${this.truncate(params.old_str, 30)}" at line ${lineNumber}`;
      await this.createBackup(targetPath, 'str_replace', description);

      // Perform replacement
      const newContent = content.replace(params.old_str, params.new_str);
      await fs.promises.writeFile(targetPath, newContent, 'utf-8');

      // Track
      this.trackRecentFile(targetPath);

      this.addEvent(
        `✅ Replaced text at line ${lineNumber} in ${params.path}\n` +
        `(undo available: {@text-editor.undo(path="${params.path}")})`,
        'text-replaced',
        `text-editor-replace-${Date.now()}`,
        { path: targetPath, lineNumber }
      );
    } catch (err: any) {
      this.emitError(`Failed to edit '${params.path}': ${err.message}`);
    }
  }

  /**
   * Handle insert command - insert text at line
   */
  private async handleInsert(params: { path: string; insert_line: number; new_str: string }): Promise<void> {
    const targetPath = this.resolvePath(params.path);
    
    try {
      const buffer = await fs.promises.readFile(targetPath);
      
      if (this.isBinaryContent(buffer)) {
        this.emitError(`Cannot edit binary file: ${params.path}`);
        return;
      }

      const content = buffer.toString('utf-8');
      const lines = content.split('\n');
      
      // Validate line number
      if (params.insert_line < 0 || params.insert_line > lines.length) {
        this.emitError(
          `Invalid line number ${params.insert_line}. File has ${lines.length} lines.\n` +
          `Use 0 to insert at beginning, or 1-${lines.length} to insert after that line.`
        );
        return;
      }

      // Create backup
      const description = `Inserted text after line ${params.insert_line}`;
      await this.createBackup(targetPath, 'insert', description);

      // Insert the text
      const newLines = params.new_str.split('\n');
      lines.splice(params.insert_line, 0, ...newLines);
      
      const newContent = lines.join('\n');
      await fs.promises.writeFile(targetPath, newContent, 'utf-8');

      // Track
      this.trackRecentFile(targetPath);

      this.addEvent(
        `✅ Inserted ${newLines.length} line(s) after line ${params.insert_line} in ${params.path}\n` +
        `(undo available: {@text-editor.undo(path="${params.path}")})`,
        'text-inserted',
        `text-editor-insert-${Date.now()}`,
        { path: targetPath, insertLine: params.insert_line, linesInserted: newLines.length }
      );
    } catch (err: any) {
      this.emitError(`Failed to edit '${params.path}': ${err.message}`);
    }
  }

  /**
   * Handle undo command - revert last edit
   */
  private async handleUndo(params: { path: string }): Promise<void> {
    const targetPath = this.resolvePath(params.path);
    const history = this.editHistory.get(targetPath);
    
    if (!history || history.length === 0) {
      this.emitError(`No edits to undo for ${params.path}`);
      return;
    }

    const lastEdit = history.pop()!;
    
    try {
      // Read backup content
      const backupContent = await fs.promises.readFile(lastEdit.backupPath, 'utf-8');
      
      if (backupContent === '__FILE_DID_NOT_EXIST__') {
        // File was created, so delete it
        await fs.promises.unlink(targetPath);
        this.addEvent(
          `✅ Undid: ${lastEdit.description}\nFile deleted (it didn't exist before).`,
          'undo-success',
          `text-editor-undo-${Date.now()}`,
          { path: targetPath, operation: lastEdit.operation }
        );
      } else {
        // Restore from backup
        await fs.promises.copyFile(lastEdit.backupPath, targetPath);
        this.addEvent(
          `✅ Undid: ${lastEdit.description}\nFile restored to previous state.`,
          'undo-success',
          `text-editor-undo-${Date.now()}`,
          { path: targetPath, operation: lastEdit.operation }
        );
      }

      // Clean up backup file
      await fs.promises.unlink(lastEdit.backupPath).catch(() => {});
      
    } catch (err: any) {
      this.emitError(`Failed to undo: ${err.message}`);
      // Put entry back
      history.push(lastEdit);
    }
  }

  /**
   * Handle setWorkingDirectory command
   */
  private async handleSetWorkingDirectory(params: { path: string }): Promise<void> {
    const newPath = this.resolvePath(params.path);
    
    try {
      const stat = await fs.promises.stat(newPath);
      if (!stat.isDirectory()) {
        this.emitError(`Not a directory: ${params.path}`);
        return;
      }

      this.workingDirectory = newPath;
      
      this.addEvent(
        `📂 Working directory changed to: ${newPath}`,
        'working-directory-changed',
        `text-editor-cwd-${Date.now()}`,
        { workingDirectory: newPath }
      );
    } catch (err: any) {
      this.emitError(`Cannot access directory '${params.path}': ${err.message}`);
    }
  }

  /**
   * Handle listRecentFiles command
   */
  private async handleListRecentFiles(): Promise<void> {
    if (this.recentFiles.length === 0) {
      this.addEvent(
        'No recent files.',
        'recent-files',
        `text-editor-recent-${Date.now()}`
      );
      return;
    }

    const list = this.recentFiles.map((f, i) => {
      const relative = path.relative(this.workingDirectory, f);
      const display = relative.startsWith('..') ? f : `./${relative}`;
      return `${i + 1}. ${display}`;
    }).join('\n');

    this.addEvent(
      `📋 Recent files:\n${list}`,
      'recent-files',
      `text-editor-recent-${Date.now()}`,
      { files: this.recentFiles }
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Emit an error event
   */
  private emitError(message: string): void {
    this.addEvent(
      `❌ ${message}`,
      'error',
      `text-editor-error-${Date.now()}`,
      { error: true }
    );
  }

  /**
   * Truncate string for display
   */
  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen - 3) + '...';
  }
}

