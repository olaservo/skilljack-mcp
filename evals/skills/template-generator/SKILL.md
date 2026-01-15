---
name: template-generator
description: Generate files from templates. Use this when asked to create a config file or generate structured output.
---

# Template Generator Skill

When asked to generate a config file or structured output, follow these steps:

1. Load the appropriate template from `templates/` using the `skill-resource` tool
2. Fill in the template with the user's values
3. Return the completed output

## Available Templates

- `templates/config.json` - JSON configuration file template

## Important

You MUST load the template using `skill-resource` before generating output. Do not generate from memory.

The template contains a marker `SKILLJACK_TEMPLATE_LOADED` that must appear in your output to confirm the template was used.
