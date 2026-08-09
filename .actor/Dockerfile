# Image de base Apify avec Playwright + Firefox.
FROM apify/actor-node-playwright-firefox:22

# Le /pw-browsers par défaut est root-only : on installe le navigateur dans le
# home de myuser (inscriptible) pour garantir une version alignée sur notre playwright.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/myuser/pw-browsers

# Deps de prod uniquement (--no-package-lock : évite un lock root-owned = EACCES).
COPY package.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional --no-package-lock \
 && npx playwright install firefox \
 && (npm list --omit=dev --all || true) \
 && echo "Node: $(node --version) / NPM: $(npm --version)" \
 && rm -rf ~/.npm

# Le code de l'actor.
COPY . ./

CMD ["npm", "start", "--silent"]
