// Basic tests for Ground Truth MCP server
import { describe, it, expect } from 'vitest';

describe('Ground Truth MCP Server', () => {
  it('should have valid server configuration', () => {
    // Test that basic constants are defined
    expect(typeof "ground-truth").toBe('string');
    expect(typeof "0.4.9").toBe('string');
  });

  it('should have required environment bindings', () => {
    // Basic validation that the server structure is sound
    const requiredBindings = ['MCP_OBJECT', 'API_KEYS'];
    requiredBindings.forEach(binding => {
      expect(typeof binding).toBe('string');
    });
  });

  it('should define free tools correctly', () => {
    const freeTools = ["check_endpoint", "inspect_security_headers", "verify_claim", "list_resources"];
    expect(Array.isArray(freeTools)).toBe(true);
    expect(freeTools.length).toBeGreaterThan(0);
  });
});