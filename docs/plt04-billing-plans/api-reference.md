# PLT04 — Billing Plans & Usage-Based Metering: API Reference

All billing/metering endpoints live under `/developer/billing/` or `/developer/plan/`.
New PLT04 endpoints are served by `billingMeteringRouter`; existing endpoints from `billing.ts` remain unchanged.

---

## Authentication

Most endpoints require a `?developerId=` query parameter.  In future this will be derived from the authenticated session; for now it is an explicit parameter.

The Stripe webhook endpoint does **not** use developer authentication — it uses Stripe signature verification instead.

---

## Endpoints

### GET /developer/billing/entitlements

Returns the plan entitlements (quota limits, feature flags) for a developer.

**Query Parameters**

| Name        | Type   | Required | Description                    |
|-------------|--------|----------|--------------------------------|
| developerId | string | Yes      | Developer ID to look up        |

**Response 200**
```json
{
  "data": {
    "maxRequestsPerDay": 100,
    "maxRequestsPerMonth": 3000,
    "maxConcurrentKeys": 3,
    "historyCutoffDays": 7,
    "maxWebhooks": 1,
    "overageRatePer1k": 0.2,
    "hasAnalytics": false,
    "hasPrioritySupport": false
  }
}
```

**Errors**

| Status | Meaning                                  |
|--------|------------------------------------------|
| 400    | `developerId` missing or empty           |
| 404    | Developer not found                      |

---

### GET /developer/billing/quota

Returns the current quota usage counters for a developer.

**Query Parameters**

| Name        | Type   | Required | Description          |
|-------------|--------|----------|----------------------|
| developerId | string | Yes      | Developer ID         |

**Response 200**
```json
{
  "data": {
    "allowed": true,
    "usagePct": 42,
    "reason": null
  }
}
```

When quota is exceeded:
```json
{
  "data": {
    "allowed": false,
    "usagePct": 100,
    "reason": "Monthly quota of 3,000 requests exceeded (used 3,001)"
  }
}
```

**Errors**

| Status | Meaning              |
|--------|----------------------|
| 400    | Missing developerId  |
| 404    | Developer not found  |

---

### GET /developer/billing/usage-summary

Returns a complete usage summary with cost estimate for a developer.

**Query Parameters**

| Name        | Type   | Required | Description  |
|-------------|--------|----------|--------------|
| developerId | string | Yes      | Developer ID |

**Response 200**
```json
{
  "data": {
    "developerId": "dev_abc123",
    "planName": "free",
    "requestsToday": 42,
    "requestsThisMonth": 1500,
    "dailyQuota": 100,
    "monthlyQuota": 3000,
    "dailyUsagePct": 42,
    "monthlyUsagePct": 50,
    "isOverDaily": false,
    "isOverMonthly": false,
    "estimatedMonthlyCost": 0,
    "currentPeriodStart": null,
    "currentPeriodEnd": null
  }
}
```

**Errors**

| Status | Meaning              |
|--------|----------------------|
| 400    | Missing developerId  |
| 404    | Developer not found  |

---

### GET /developer/billing/billing-events

Returns billing event history for a developer, most-recent first.

**Query Parameters**

| Name        | Type   | Required | Default | Description                   |
|-------------|--------|----------|---------|-------------------------------|
| developerId | string | Yes      | —       | Developer ID                  |
| limit       | number | No       | 50      | Max results (1–200)           |
| offset      | number | No       | 0       | Pagination offset             |

**Response 200**
```json
{
  "data": [
    {
      "id": "evt_abc123",
      "developerId": "dev_xyz",
      "eventType": "plan_changed",
      "fromPlanId": "plan_free",
      "toPlanId": "plan_pro",
      "amountCents": null,
      "currency": "USD",
      "stripeEventId": null,
      "metadata": { "targetPlan": "pro", "source": "stripe_checkout" },
      "createdAt": "2026-09-28T11:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

**Event Types**

| eventType               | Trigger                                           |
|-------------------------|---------------------------------------------------|
| `plan_changed`          | Plan changed (upgrade, downgrade, or admin change)|
| `upgrade_initiated`     | Stripe checkout session created                   |
| `payment_succeeded`     | Stripe invoice or checkout payment confirmed      |
| `payment_failed`        | Stripe invoice payment failed                     |
| `subscription_canceled` | Stripe subscription deleted or paused             |
| `subscription_updated`  | Stripe subscription status changed                |
| `overage_charged`       | Overage billing event (future)                    |
| `trial_started`         | Trial period began (future)                       |
| `trial_ended`           | Trial period ended (future)                       |

---

### POST /developer/billing/plan/upgrade

Initiates a Stripe Checkout session for a plan upgrade.

**Request Body**

```json
{
  "developerId": "dev_abc123",
  "targetPlan": "pro",
  "successUrl": "https://app.example.com/billing/success",
  "cancelUrl": "https://app.example.com/billing/cancel"
}
```

| Field       | Type                                | Required | Description                          |
|-------------|-------------------------------------|----------|--------------------------------------|
| developerId | string                              | Yes      | Developer ID                         |
| targetPlan  | `"developer"` \| `"pro"` \| `"enterprise"` | Yes | Target plan name              |
| successUrl  | URL string                          | Yes      | Stripe redirects here on success     |
| cancelUrl   | URL string                          | Yes      | Stripe redirects here on cancel      |

**Response 200**
```json
{
  "checkoutUrl": "https://checkout.stripe.com/pay/cs_test_abc123",
  "sessionId": "cs_test_abc123"
}
```

**Errors**

| Status | Meaning                               |
|--------|---------------------------------------|
| 400    | Validation error (invalid body)       |
| 404    | Developer or target plan not found    |
| 500    | Stripe session creation failed        |

---

### POST /developer/billing/plan/downgrade

Immediately downgrades a developer to a lower plan.  Does not go through Stripe — for free and developer plans only.

**Request Body**

```json
{
  "developerId": "dev_abc123",
  "targetPlan": "free"
}
```

| Field       | Type                      | Required | Description              |
|-------------|---------------------------|----------|--------------------------|
| developerId | string                    | Yes      | Developer ID             |
| targetPlan  | `"free"` \| `"developer"` | Yes      | Target plan name         |

**Response 200**
```json
{
  "message": "Plan downgraded to free",
  "planId": "plan_abc123"
}
```

**Errors**

| Status | Meaning                             |
|--------|-------------------------------------|
| 400    | Validation error                    |
| 404    | Developer or target plan not found  |

---

### GET /developer/plan/compare

Returns a full plan comparison matrix.  No authentication required.

**Query Parameters** — none

**Response 200**
```json
{
  "data": [
    {
      "id": "plan_free",
      "name": "free",
      "priceMonthly": 0,
      "requestsPerDay": 100,
      "requestsPerMonth": 3000,
      "trialDays": 0,
      "sortOrder": 0,
      "entitlements": {
        "maxRequestsPerDay": 100,
        "maxRequestsPerMonth": 3000,
        "maxConcurrentKeys": 3,
        "historyCutoffDays": 7,
        "maxWebhooks": 1,
        "overageRatePer1k": 0.2,
        "hasAnalytics": false,
        "hasPrioritySupport": false
      }
    },
    {
      "id": "plan_developer",
      "name": "developer",
      "priceMonthly": 10,
      "requestsPerDay": 10000,
      "requestsPerMonth": 300000,
      "trialDays": 0,
      "sortOrder": 1,
      "entitlements": {
        "maxRequestsPerDay": 10000,
        "maxRequestsPerMonth": 300000,
        "maxConcurrentKeys": 10,
        "historyCutoffDays": 30,
        "maxWebhooks": 5,
        "overageRatePer1k": 0.1,
        "hasAnalytics": false,
        "hasPrioritySupport": false
      }
    }
  ]
}
```

---

### POST /developer/billing/webhook/stripe

Enhanced Stripe webhook endpoint.  Must receive a raw body (not JSON-parsed).

**Headers**

| Header             | Required | Description                      |
|--------------------|----------|----------------------------------|
| `stripe-signature` | Yes      | Stripe HMAC signature header     |
| `Content-Type`     | Yes      | Must be `application/json`       |

**Supported Stripe Event Types**

| Event Type                          | Billing Event Created       |
|-------------------------------------|-----------------------------|
| `checkout.session.completed`        | `payment_succeeded`, `plan_changed` |
| `customer.subscription.deleted`     | `subscription_canceled`     |
| `customer.subscription.paused`      | `subscription_canceled`     |
| `customer.subscription.updated`     | `subscription_updated`      |
| `invoice.payment_succeeded`         | `payment_succeeded`         |
| `invoice.payment_failed`            | `payment_failed`            |

**Response 200**
```json
{
  "received": true,
  "eventId": "evt_1ABC..."
}
```

**Errors**

| Status | Meaning                              |
|--------|--------------------------------------|
| 400    | Missing signature header             |
| 400    | Raw body not available               |
| 400    | Stripe signature verification failed |

**Example Webhook Payloads**

`checkout.session.completed`:
```json
{
  "id": "evt_1ABC...",
  "type": "checkout.session.completed",
  "data": {
    "object": {
      "id": "cs_test_abc123",
      "amount_total": 5000,
      "metadata": {
        "developerId": "dev_abc123",
        "tier": "pro"
      }
    }
  }
}
```

`invoice.payment_failed`:
```json
{
  "id": "evt_1DEF...",
  "type": "invoice.payment_failed",
  "data": {
    "object": {
      "id": "in_abc123",
      "customer": "cus_abc123",
      "amount_due": 5000,
      "currency": "usd",
      "attempt_count": 2
    }
  }
}
```

---

## Quota Exceeded Response (429)

When the `quotaEnforcementMiddleware` rejects a request:

```json
{
  "error": "Quota exceeded",
  "reason": "Monthly quota of 3,000 requests exceeded (used 3,001)",
  "usagePct": 100,
  "upgradeUrl": "/developer/billing/plan/upgrade"
}
```

---

## Error Codes Summary

| HTTP Status | Error String           | Meaning                                          |
|-------------|------------------------|--------------------------------------------------|
| 400         | `Validation failed`    | Request body or query params failed Zod schema   |
| 400         | `Invalid webhook signature` | Stripe HMAC check failed                    |
| 400         | `Raw body required`    | Express did not forward raw body to webhook route|
| 404         | `Developer not found`  | No developer row for given `developerId`         |
| 404         | `Plan not found`       | No `_billing_plans` row for given plan name      |
| 429         | `Quota exceeded`       | Daily or monthly request quota surpassed         |
| 500         | (propagated)           | Unexpected server error — see server logs        |
