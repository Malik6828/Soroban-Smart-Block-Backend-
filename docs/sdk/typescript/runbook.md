# TypeScript SDK — Runbook

## Regenerate after an API change

```bash
npm run sdk:generate          # rewrites generated files + parity matrix
npm run sdk:breaking          # semver check vs origin/main
npm run sdk:build             # compile packages/client
```

Commit the generated files with the API change. CI fails on drift
(`npm run sdk:check`) or on a missing version bump (`npm run sdk:breaking`).

## Pre-Release Validation

Before releasing, run the full validation suite:

```bash
npm run sdk:generate          # Generate SDKs
npm run sdk:check             # Verify no drift
npm run sdk:breaking          # Check semver compliance
npm run sdk:audit:security    # Security audit
npm run sdk:test:chaos        # Chaos tests
npm run sdk:test:load         # Load tests
npm run sdk:bench             # Performance benchmarks
```

All validations must pass before proceeding with release.

## Debug

|| Symptom                                     | Action                                                                                                                                                     |
|| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
|| `SDK drift` in CI                           | Run `npm run sdk:generate`, commit.                                                                                                                        |
|| Operation missing from SDK                  | It is missing from `/api/v1/openapi.json`; stderr `[swagger] Skipped … malformed docs` names the broken route file.                                        |
|| Response typed `unknown`                    | The spec has no JSON schema for its 2xx response (or a dangling `$ref`). Add one in the `@swagger` block.                                                  |
|| `breaking API changes require a major bump` | Either restore compatibility or bump `packages/client/package.json` (and the Python `pyproject.toml`) to the next major and follow the deprecation policy. |
|| Users report retries storms                 | Check `Retry-After` headers from the API; SDK caps waits at `maxRetryDelayMs`.                                                                             |
|| Generation latency > 5s                     | Check SLO dashboard, review spec complexity, consider feature flags for optimization.                                                                       |
|| Circuit breaker频繁触发                      | Review failing component logs, check for transient issues, consider increasing timeout.                                                                       |
|| Security audit fails                        | Review security report, fix identified issues, re-run audit.                                                                                               |

Enable SDK-side diagnostics in an app:

```ts
new SorobanClient({ logger: console, onRequest: (e) => console.log(e) });
```

Enable debug logging for SDK generation:

```bash
export DEBUG_METRICS=true
export DEBUG_CIRCUIT_BREAKER=true
npm run sdk:generate
```

## Monitoring

### SLO Dashboard

Monitor the SLO dashboard (`docs/sdk/grafana-dashboard.json`) for:
- Generation success rate (target: 99.9%)
- P95 latency (target: < 5s)
- Error budget remaining
- Drift detection rate (target: < 1%)

### Error Budget Actions

- **Healthy (>50% remaining)**: Normal operations
- **Depleting (25-50%)**: Reduce deployment frequency, enhance monitoring
- **Critical (<25%)**: Stop deployments, on-call escalation
- **Exhausted (0%)**: Complete freeze, emergency response

### Metrics Debugging

View current metrics:

```bash
export DEBUG_METRICS=true
npm run sdk:generate
```

Check circuit breaker status:

```bash
export DEBUG_CIRCUIT_BREAKER=true
npm run sdk:generate
```

## Feature Flag Management

### Enable/Disable Features

```bash
# Enable TypeScript generation
export SDK_FEATURE_TYPESCRIPT_GENERATION=true

# Disable Python generation
export SDK_FEATURE_PYTHON_GENERATION=false

# Enable experimental features
export SDK_FEATURE_EXPERIMENTAL_GENERATORS=true
```

### Gradual Rollout

```bash
# Roll out parallel generation to 20% of requests
export SDK_ROLLOUT_PARALLEL_GENERATION=20
```

### Check Current Flags

Run generation with debug output to see enabled flags:
```bash
npm run sdk:generate
# Check logs for "enabled_flags" field
```

## Release

1. **Pre-Release Validation**
   ```bash
   npm run sdk:generate
   npm run sdk:check
   npm run sdk:breaking
   npm run sdk:audit:security
   npm run sdk:test:chaos
   npm run sdk:test:load
   npm run sdk:bench
   ```

2. **Version Bump**
   - Update `packages/client/package.json` per semver policy in `docs/sdk/versioning.md`
   - Update CHANGELOG.md with changes
   - Commit changes

3. **Tag and Publish**
   ```bash
   git tag client-v<version>
   git push origin client-v<version>
   ```
   - CI will verify drift, run tests, build, and publish with provenance
   - Requires `NPM_TOKEN` secret configured

4. **Post-Release Verification**
   - Monitor SLO dashboard for 24 hours
   - Check error budget consumption
   - Review user feedback and issues

## Incident Response

### SEV1 (Critical) - Complete Generation Failure

**Response Time**: 15 minutes

**Actions**:
1. Stop all SDK deployments
2. Enable emergency mode (disable feature flags)
3. Check SLO dashboard for error patterns
4. Review logs for root cause
5. Implement hotfix if possible
6. Escalate to on-call + engineering manager

**Recovery**:
1. Fix root cause
2. Run full validation suite
3. Deploy fix to staging
4. Monitor for 1 hour
5. Deploy to production
6. Post-mortem required

### SEV2 (High) - Performance Degradation

**Response Time**: 30 minutes

**Actions**:
1. Reduce deployment frequency
2. Enable enhanced monitoring
3. Check for resource exhaustion
4. Review recent changes
5. Consider feature flag rollback

**Recovery**:
1. Identify bottleneck
2. Implement optimization
3. Test with load tests
4. Deploy with feature flag
5. Monitor performance

### SEV3 (Medium) - Partial Failure

**Response Time**: 1 hour

**Actions**:
1. Monitor error rates
2. Check graceful degradation status
3. Review fallback activation
4. Plan fix for next release

**Recovery**:
1. Fix affected component
2. Test with chaos tests
3. Deploy in next release cycle

## Recover / Roll Back a Bad Release

### SDK Rollback

```bash
# Deprecate bad release
npm deprecate @soroban-explorer/client@<bad> "broken release, use <good>"

# Restore latest good version
npm dist-tag add @soroban-explorer/client@<good> latest
```

### Pipeline Rollback

```bash
# Disable problematic feature flags
export SDK_FEATURE_EXPERIMENTAL_GENERATORS=false

# Reset circuit breakers (manual intervention or wait for timeout)
```

### Repository Rollback

```bash
# Revert problematic commit
git revert <commit-hash>
git push origin main

# Regenerate SDKs if needed
npm run sdk:generate
git commit -am "Regenerate SDKs after rollback"
git push
```

### Emergency Procedures

**Complete Pipeline Failure**:
1. Enable manual SDK generation mode
2. Disable all feature flags except core ones
3. Use fallback implementations where available
4. Communicate status to users

**Security Incident**:
1. Immediately disable affected components
2. Run full security audit
3. Rotate any exposed credentials
4. Publish security advisory
5. Coordinate with security team

## Performance Tuning

### Optimization Flags

```bash
# Enable parallel generation (gradual rollout)
export SDK_ROLLOUT_PARALLEL_GENERATION=20

# Enable cache optimization (gradual rollout)
export SDK_ROLLOUT_CACHE_OPTIMIZATION=10
```

### Circuit Breaker Tuning

Adjust in code or via environment:

```typescript
gracefulDegradation.configure({
  maxRetries: 3,
  retryDelay: 1000,
  circuitBreakerThreshold: 5,
  circuitBreakerTimeout: 60000,
});
```

### Monitoring Performance

Run benchmarks regularly:

```bash
npm run sdk:bench
```

Run load tests before major changes:

```bash
npm run sdk:test:load
```

## Security Operations

### Regular Security Audits

```bash
# Run full security audit
npm run sdk:audit:security

# Check for vulnerable dependencies
npm audit

# Review CI workflow security
# Manual review of .github/workflows/
```

### Secret Management

- Never commit secrets to repository
- Use environment variables for configuration
- Rotate credentials regularly
- Audit secret access logs

### Dependency Updates

```bash
# Check for outdated dependencies
npm outdated

# Update dependencies (review changes first)
npm update

# Audit for vulnerabilities
npm audit fix
```

## Troubleshooting Common Issues

### Generation Failures

**Issue**: `SDK generation failed`

**Steps**:
1. Check OpenAPI spec validity: `curl http://localhost:3000/api/v1/openapi.json | jq .`
2. Review logs for specific error messages
3. Check feature flag configuration
4. Verify dependencies are installed
5. Try with debug logging enabled

### Performance Issues

**Issue**: Generation taking > 5 seconds

**Steps**:
1. Check spec complexity (operation count)
2. Review metrics for bottlenecks
3. Consider enabling parallel generation
4. Check for resource constraints
5. Run performance benchmarks

### CI Failures

**Issue**: CI failing on `sdk:check`

**Steps**:
1. Run `npm run sdk:generate` locally
2. Commit generated files
3. Check for git configuration issues
4. Verify CI environment matches local

### Security Audit Failures

**Issue**: Security audit finds issues

**Steps**:
1. Review audit report for specific issues
2. Fix identified vulnerabilities
3. Update dependencies if needed
4. Re-run audit to verify fixes
5. Document security changes

## Maintenance Tasks

### Daily
- Monitor SLO dashboard
- Review error budget consumption
- Check for critical alerts

### Weekly
- Review performance trends
- Check feature flag adoption
- Review security audit results

### Monthly
- Run full validation suite
- Review and update documentation
- Analyze incident patterns

### Quarterly
- SLO target review and adjustment
- Architecture review
- Security assessment
- Performance optimization planning

## Documentation Updates

Keep the following documentation current:
- This runbook
- SLO documentation (`docs/sdk/slo-error-budgets.md`)
- Design documentation (`docs/sdk/pipeline-design.md`)
- API references
- CHANGELOG.md

## Contact and Escalation

**On-Call**: [Slack channel]
**Engineering Manager**: [email]
**Security Team**: [email]
**Product Team**: [email]

For critical issues, use the escalation matrix defined in the incident response procedures.
