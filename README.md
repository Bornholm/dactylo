# Dactylo

Extension Thunderbird qui intègre un assistant LLM directement dans la fenêtre de composition d'emails.

## Fonctionnalités

- **Trois modes d'assistance** : corriger, améliorer ou composer un email
- **Connexion à n'importe quel LLM** compatible OpenAI (API key, modèle, température configurables)
- **Serveurs MCP** (Model Context Protocol) via transport Streamable HTTP — fournit des outils supplémentaires au LLM
- **Prompts système** nommés et gérables, avec notion de prompt par défaut
- **Préservation automatique** de la signature et du fil de réponse (HTML et texte brut)
- **Historique de conversation** par onglet de composition

## Prérequis

- Thunderbird ≥ 115
- Node.js ≥ 18

## Installation

```bash
npm install
npm run package   # génère dactylo.xpi
```

Charger l'extension dans Thunderbird : *Outils → Modules complémentaires → Installer depuis un fichier*.

## Développement

```bash
npm run watch   # compilation incrémentale
```

Les sources TypeScript se trouvent dans `src/`. Le build produit l'extension dans `dist/`.

## Configuration

Depuis les options de l'extension (icône dans la barre de composition) :

| Onglet | Paramètres |
|--------|-----------|
| LLM | Endpoint, clé API, modèle, température, tokens max |
| Prompts | Création / édition de prompts système |
| MCP | Ajout de serveurs MCP (URL + en-têtes HTTP) |
