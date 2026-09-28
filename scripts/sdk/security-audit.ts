/**
 * Security audit for SDK generation pipeline.
 * Validates input sanitization, dependency security, and access controls.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

interface SecurityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  message: string;
  file?: string;
  line?: number;
}

class SecurityAuditor {
  private issues: SecurityIssue[] = [];

  auditOpenAPISpec(specPath: string): SecurityIssue[] {
    try {
      const specContent = fs.readFileSync(specPath, 'utf8');
      const spec = JSON.parse(specContent);
      
      this.checkForSecretsInSpec(spec, specPath);
      this.checkForSSRFRisks(spec, specPath);
      this.checkForInjectionRisks(spec, specPath);
      this.checkForAuthenticationRequirements(spec, specPath);
      
    } catch (error) {
      this.addIssue('critical', 'file-read', `Failed to read OpenAPI spec: ${error}`, specPath);
    }
    
    return this.issues;
  }

  auditGeneratedFiles(generatedDir: string): SecurityIssue[] {
    try {
      const files = this.getGeneratedFiles(generatedDir);
      
      for (const file of files) {
        this.checkForCodeInjection(file);
        this.checkForHardcodedSecrets(file);
        this.checkForUnsafeDependencies(file);
        this.checkForExposureOfSensitiveData(file);
      }
      
    } catch (error) {
      this.addIssue('critical', 'file-read', `Failed to audit generated files: ${error}`);
    }
    
    return this.issues;
  }

  auditDependencies(packageJsonPath: string): SecurityIssue[] {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
      
      this.checkForVulnerableDependencies(dependencies, packageJsonPath);
      this.checkForUnnecessaryDependencies(dependencies, packageJsonPath);
      this.checkForOutdatedDependencies(dependencies, packageJsonPath);
      
    } catch (error) {
      this.addIssue('critical', 'file-read', `Failed to audit dependencies: ${error}`, packageJsonPath);
    }
    
    return this.issues;
  }

  auditCIWorkflows(workflowsDir: string): SecurityIssue[] {
    try {
      const workflowFiles = fs.readdirSync(workflowsDir)
        .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map(f => path.join(workflowsDir, f));
      
      for (const workflowFile of workflowFiles) {
        this.checkForSecretsInWorkflow(workflowFile);
        this.checkForInjectionInWorkflow(workflowFile);
        this.checkForUnrestrictedPermissions(workflowFile);
      }
      
    } catch (error) {
      this.addIssue('medium', 'workflow-audit', `Failed to audit CI workflows: ${error}`);
    }
    
    return this.issues;
  }

  private checkForSecretsInSpec(spec: any, filePath: string): void {
    const secretPatterns = [
      /password/i,
      /secret/i,
      /api[_-]?key/i,
      /token/i,
      /credential/i,
    ];

    const checkObject = (obj: any, path: string = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;
        
        if (typeof value === 'string') {
          for (const pattern of secretPatterns) {
            if (pattern.test(key) && value.length > 10) {
              this.addIssue('high', 'secret-exposure', 
                `Potential secret in OpenAPI spec: ${currentPath}`, filePath);
            }
          }
        } else if (typeof value === 'object' && value !== null) {
          checkObject(value, currentPath);
        }
      }
    };

    checkObject(spec);
  }

  private checkForSSRFRisks(spec: any, filePath: string): void {
    const checkForURLParams = (obj: any, path: string = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;
        
        if (key === 'in' && value === 'query') {
          // Check if this parameter might be used for SSRF
          const parent = this.getParentPath(obj, path);
          if (parent && (parent.includes('url') || parent.includes('endpoint') || parent.includes('host'))) {
            this.addIssue('high', 'ssrf-risk', 
              `Potential SSRF risk in parameter: ${currentPath}`, filePath);
          }
        } else if (typeof value === 'object' && value !== null) {
          checkForURLParams(value, currentPath);
        }
      }
    };

    checkForURLParams(spec);
  }

  private checkForInjectionRisks(spec: any, filePath: string): void {
    // Check for operations that might be vulnerable to injection
    if (spec.paths) {
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(methods)) {
          if (typeof operation === 'object' && operation !== null) {
            const op = operation as any;
            
            // Check for operations that accept user input without validation
            if (op.requestBody && op.requestBody.content) {
              for (const contentType of Object.keys(op.requestBody.content)) {
                if (contentType.includes('json') || contentType.includes('xml')) {
                  this.addIssue('medium', 'injection-risk', 
                    `Operation ${method.toUpperCase()} ${path} accepts ${contentType} without documented validation`, 
                    filePath);
                }
              }
            }
          }
        }
      }
    }
  }

  private checkForAuthenticationRequirements(spec: any, filePath: string): void {
    if (spec.paths) {
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, operation] of Object.entries(methods)) {
          if (typeof operation === 'object' && operation !== null) {
            const op = operation as any;
            
            // Check if operation has security requirements
            if (!op.security && !spec.security) {
              // Some operations might intentionally be public, so this is medium severity
              this.addIssue('medium', 'authentication', 
                `Operation ${method.toUpperCase()} ${path} has no security requirements`, 
                filePath);
            }
          }
        }
      }
    }
  }

  private checkForCodeInjection(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Check for eval() or similar dangerous patterns
    const dangerousPatterns = [
      /eval\s*\(/,
      /Function\s*\(/,
      /new\s+Function\s*\(/,
      /document\.write/,
      /innerHTML\s*=/,
      /outerHTML\s*=/,
    ];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of dangerousPatterns) {
        if (pattern.test(lines[i])) {
          this.addIssue('critical', 'code-injection', 
            `Dangerous code pattern detected: ${pattern}`, filePath, i + 1);
        }
      }
    }
  }

  private checkForHardcodedSecrets(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf8');
    
    const secretPatterns = [
      /['"](?:sk_|pk_|ak_|sk-|pk-|ak-)[a-zA-Z0-9]{20,}['"]/, // API keys
      /['"][a-zA-Z0-9]{32,}['"]/, // Long hex strings (potential keys)
      /password\s*=\s*['"][^'"]{8,}['"]/, // Passwords
      /secret\s*=\s*['"][^'"]{8,}['"]/, // Secrets
    ];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of secretPatterns) {
        if (pattern.test(lines[i])) {
          this.addIssue('critical', 'hardcoded-secret', 
            `Potential hardcoded secret detected`, filePath, i + 1);
        }
      }
    }
  }

  private checkForUnsafeDependencies(filePath: string): void {
    if (!filePath.endsWith('package.json')) return;
    
    const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
    
    // Known vulnerable or unsafe packages
    const unsafePackages = [
      'eval',
      'function-bind',
      'shelljs',
      'exec-sync',
    ];

    for (const [name, version] of Object.entries(dependencies)) {
      if (unsafePackages.includes(name)) {
        this.addIssue('high', 'unsafe-dependency', 
          `Unsafe dependency: ${name}@${version}`, filePath);
      }
    }
  }

  private checkForExposureOfSensitiveData(filePath: string): void {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Check for exposure of sensitive data in logs or error messages
    const sensitivePatterns = [
      /console\.log\([^)]*password[^)]*\)/i,
      /console\.log\([^)]*token[^)]*\)/i,
      /console\.log\([^)]*secret[^)]*\)/i,
      /console\.error\([^)]*password[^)]*\)/i,
    ];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of sensitivePatterns) {
        if (pattern.test(lines[i])) {
          this.addIssue('medium', 'data-exposure', 
            `Sensitive data potentially exposed in logs`, filePath, i + 1);
        }
      }
    }
  }

  private checkForVulnerableDependencies(dependencies: Record<string, string>, filePath: string): void {
    // This would typically integrate with npm audit or similar tools
    // For now, we'll check for known outdated versions
    const knownVulnerable = {
      'lodash': '<4.17.21',
      'axios': '<0.21.1',
      'node-fetch': '<2.6.1',
    };

    for (const [name, version] of Object.entries(dependencies)) {
      if (knownVulnerable[name as keyof typeof knownVulnerable]) {
        this.addIssue('high', 'vulnerable-dependency', 
          `Dependency ${name}@${version} may be vulnerable`, filePath);
      }
    }
  }

  private checkForUnnecessaryDependencies(dependencies: Record<string, string>, filePath: string): void {
    // Check for dependencies that might not be needed in SDK generation
    const unnecessaryInSDK = [
      'express',
      'koa',
      'fastify',
      'mongodb',
      'redis',
    ];

    for (const [name, version] of Object.entries(dependencies)) {
      if (unnecessaryInSDK.includes(name)) {
        this.addIssue('low', 'unnecessary-dependency', 
          `Potentially unnecessary dependency for SDK: ${name}`, filePath);
      }
    }
  }

  private checkForOutdatedDependencies(dependencies: Record<string, string>, filePath: string): void {
    // Check for very old versions that might have security issues
    for (const [name, version] of Object.entries(dependencies)) {
      const versionMatch = version.match(/^\^?(\d+)\./);
      if (versionMatch) {
        const majorVersion = parseInt(versionMatch[1], 10);
        if (majorVersion < 1) {
          this.addIssue('medium', 'outdated-dependency', 
            `Dependency ${name}@${version} is very old and may have security issues`, filePath);
        }
      }
    }
  }

  private checkForSecretsInWorkflow(workflowFile: string): void {
    const content = fs.readFileSync(workflowFile, 'utf8');
    
    // Check for hardcoded secrets in workflows
    const secretPatterns = [
      /[A-Z_]+:\s*['"][^'"]{20,}['"]/, // Potential secrets
      /password:\s*['"][^'"]+/,
      /token:\s*['"][^'"]+/,
    ];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of secretPatterns) {
        if (pattern.test(lines[i]) && !lines[i].includes('${{')) {
          this.addIssue('critical', 'workflow-secret', 
            `Potential hardcoded secret in workflow`, workflowFile, i + 1);
        }
      }
    }
  }

  private checkForInjectionInWorkflow(workflowFile: string): void {
    const content = fs.readFileSync(workflowFile, 'utf8');
    
    // Check for command injection risks
    const injectionPatterns = [
      /run:\s*\${{\s*github\.event/,
      /run:\s*curl/,
      /run:\s*wget/,
    ];

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of injectionPatterns) {
        if (pattern.test(lines[i])) {
          this.addIssue('medium', 'workflow-injection', 
            `Potential command injection risk in workflow`, workflowFile, i + 1);
        }
      }
    }
  }

  private checkForUnrestrictedPermissions(workflowFile: string): void {
    const content = fs.readFileSync(workflowFile, 'utf8');
    
    // Check for overly permissive permissions
    if (content.includes('permissions: write-all')) {
      this.addIssue('high', 'workflow-permissions', 
        `Workflow has unrestricted write-all permissions`, workflowFile);
    }

    if (content.includes('contents: write') && !content.includes('pull-request')) {
      this.addIssue('medium', 'workflow-permissions', 
        `Workflow has contents:write without pull-request restriction`, workflowFile);
    }
  }

  private getGeneratedFiles(dir: string): string[] {
    const files: string[] = [];
    
    if (!fs.existsSync(dir)) return files;
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        files.push(...this.getGeneratedFiles(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js') || entry.name.endsWith('.py'))) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  private getParentPath(obj: any, currentPath: string): string | null {
    // Simplified - in a real implementation, this would traverse up the object tree
    return currentPath.split('.').slice(0, -1).join('.');
  }

  private addIssue(severity: SecurityIssue['severity'], category: string, message: string, file?: string, line?: number): void {
    this.issues.push({ severity, category, message, file, line });
  }

  getIssues(): SecurityIssue[] {
    return this.issues;
  }

  getCriticalIssues(): SecurityIssue[] {
    return this.issues.filter(i => i.severity === 'critical');
  }

  getHighIssues(): SecurityIssue[] {
    return this.issues.filter(i => i.severity === 'high');
  }

  generateReport(): string {
    const report: string[] = [];
    
    report.push('# Security Audit Report');
    report.push(`Generated: ${new Date().toISOString()}`);
    report.push('');
    
    const criticalCount = this.issues.filter(i => i.severity === 'critical').length;
    const highCount = this.issues.filter(i => i.severity === 'high').length;
    const mediumCount = this.issues.filter(i => i.severity === 'medium').length;
    const lowCount = this.issues.filter(i => i.severity === 'low').length;
    
    report.push('## Summary');
    report.push(`- Critical: ${criticalCount}`);
    report.push(`- High: ${highCount}`);
    report.push(`- Medium: ${mediumCount}`);
    report.push(`- Low: ${lowCount}`);
    report.push('');
    
    if (criticalCount > 0) {
      report.push('## Critical Issues');
      this.issues.filter(i => i.severity === 'critical').forEach(issue => {
        report.push(`- [${issue.file || 'N/A'}:${issue.line || 'N/A'}] ${issue.message}`);
      });
      report.push('');
    }
    
    if (highCount > 0) {
      report.push('## High Issues');
      this.issues.filter(i => i.severity === 'high').forEach(issue => {
        report.push(`- [${issue.file || 'N/A'}:${issue.line || 'N/A'}] ${issue.message}`);
      });
      report.push('');
    }
    
    return report.join('\n');
  }
}

// Main audit function
export function auditSDKPipeline(): { success: boolean; issues: SecurityIssue[]; report: string } {
  const auditor = new SecurityAuditor();
  const root = path.join(__dirname, '..', '..');
  
  // Audit OpenAPI spec
  const specPath = path.join(root, 'src/indexer/swaggerSpec.ts');
  auditor.auditOpenAPISpec(specPath);
  
  // Audit generated files
  const generatedDir = path.join(root, 'packages/client/src/generated');
  auditor.auditGeneratedFiles(generatedDir);
  
  // Audit dependencies
  const packageJsonPath = path.join(root, 'package.json');
  auditor.auditDependencies(packageJsonPath);
  
  // Audit CI workflows
  const workflowsDir = path.join(root, '.github/workflows');
  auditor.auditCIWorkflows(workflowsDir);
  
  const issues = auditor.getIssues();
  const criticalIssues = auditor.getCriticalIssues();
  const highIssues = auditor.getHighIssues();
  
  return {
    success: criticalIssues.length === 0 && highIssues.length === 0,
    issues,
    report: auditor.generateReport(),
  };
}

// CLI interface
if (require.main === module) {
  const result = auditSDKPipeline();
  
  console.log(result.report);
  
  if (!result.success) {
    process.exit(1);
  }
}
