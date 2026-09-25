import { describe, expect, test } from "@jest/globals";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createEntraTokenVerifier } from "../dist/entra-oauth.js";

const ISSUER =
  "https://login.microsoftonline.com/tenant-id/v2.0";
const AUDIENCE = "resource-app-id";
const RESOURCE = "https://research.example.com/mcp";

async function signingFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "test-key";
  publicJwk.use = "sig";
  const keySet = createLocalJWKSet({ keys: [publicJwk] });

  const sign = ({
    audience = AUDIENCE,
    scope = "mcp.read",
    expires = true,
  } = {}) => {
    let token = new SignJWT({
      azp: "chatgpt-client",
      scp: scope,
      tid: "tenant-id",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(audience)
      .setSubject("user-id")
      .setIssuedAt();
    if (expires) token = token.setExpirationTime("5m");
    return token.sign(privateKey);
  };

  return { keySet, sign };
}

describe("Entra OAuth token verification", () => {
  test("validates signature, issuer, audience, expiry, and scope", async () => {
    const { keySet, sign } = await signingFixture();
    const verifier = createEntraTokenVerifier(
      {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: "https://login.example.com/keys",
        resource: RESOURCE,
        requiredScope: "mcp.read",
      },
      keySet,
    );

    const auth = await verifier.verifyAccessToken(await sign());
    expect(auth).toMatchObject({
      clientId: "chatgpt-client",
      scopes: ["mcp.read"],
      resource: new URL(RESOURCE),
      extra: {
        subject: "user-id",
        tenantId: "tenant-id",
      },
    });
  });

  test("rejects the wrong audience or a missing required scope", async () => {
    const { keySet, sign } = await signingFixture();
    const verifier = createEntraTokenVerifier(
      {
        issuer: ISSUER,
        audience: AUDIENCE,
        jwksUrl: "https://login.example.com/keys",
        resource: RESOURCE,
        requiredScope: "mcp.read",
      },
      keySet,
    );

    await expect(
      verifier.verifyAccessToken(
        await sign({ audience: "another-resource" }),
      ),
    ).rejects.toThrow();
    await expect(
      verifier.verifyAccessToken(await sign({ scope: "other.scope" })),
    ).rejects.toThrow("required scope");
    await expect(
      verifier.verifyAccessToken(await sign({ expires: false })),
    ).rejects.toThrow();
  });
});
