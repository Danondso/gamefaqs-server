/**
 * OpenAPI 3.0 spec for GameFAQs Server API.
 * Served at /api-docs for Swagger UI.
 */
export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'GameFAQs Server API',
    description:
      'REST API for the GameFAQs guide archive. Lists guides and games, full-text search, health checks, and admin status.',
    version: '1.0.0',
  },
  servers: [{ url: '/', description: 'Current host' }],
  tags: [
    { name: 'Health', description: 'Health and readiness checks' },
    { name: 'Guides', description: 'GameFAQs guides (list, search, content)' },
    { name: 'Bookmarks', description: 'Bookmarks for guides' },
    { name: 'Notes', description: 'Notes for guides' },
    { name: 'Games', description: 'Games and guides by game' },
    { name: 'Admin', description: 'Admin status (optional token)' },
  ],
  paths: {
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Returns server health and init stage.',
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'healthy' },
                    initialized: { type: 'boolean' },
                    initStage: { type: 'string' },
                    uptime: { type: 'number' },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness',
        description: 'Kubernetes/Docker readiness. 503 until init complete.',
        responses: {
          '200': { description: 'Ready' },
          '503': { description: 'Not ready' },
        },
      },
    },
    '/api/health/live': {
      get: {
        tags: ['Health'],
        summary: 'Liveness',
        description: 'Kubernetes/Docker liveness. Always 200 if server is up.',
        responses: { '200': { description: 'Live' } },
      },
    },
    '/api/health/stats': {
      get: {
        tags: ['Health'],
        summary: 'Database stats',
        description: 'Guide/game counts and server info when initialized.',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/guides': {
      get: {
        tags: ['Guides'],
        summary: 'List guides',
        description: 'Paginated list (summary, no full content).',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/GuideSummary' } },
                    pagination: { $ref: '#/components/schemas/Pagination' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/guides/search': {
      get: {
        tags: ['Guides'],
        summary: 'Search guides',
        description: 'Full-text search. Requires query `q`.',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Search query is required' },
        },
      },
    },
    '/api/guides/{id}': {
      get: {
        tags: ['Guides'],
        summary: 'Get guide by ID',
        description: 'Full guide including content.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Guide not found' },
        },
      },
    },
    '/api/guides/{id}/content': {
      get: {
        tags: ['Guides'],
        summary: 'Get guide content only',
        description: 'Raw content (text/html/md) for download.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Guide not found' },
        },
      },
    },
    '/api/guides/{id}/metadata': {
      get: {
        tags: ['Guides'],
        summary: 'Get guide metadata',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Guide not found' },
        },
      },
    },
    '/api/guides/{id}/position': {
      put: {
        tags: ['Guides'],
        summary: 'Update last read position',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['position'], properties: { position: { type: 'number', minimum: 0 } } },
            },
          },
        },
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Invalid position' },
          '404': { description: 'Guide not found' },
        },
      },
    },
    '/api/guides/{guideId}/bookmarks': {
      get: {
        tags: ['Bookmarks'],
        summary: 'List bookmarks for a guide',
        parameters: [{ name: 'guideId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Bookmark' } },
                  },
                },
              },
            },
          },
          '404': { description: 'Guide not found' },
        },
      },
      post: {
        tags: ['Bookmarks'],
        summary: 'Create bookmark',
        parameters: [{ name: 'guideId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['position'],
                properties: {
                  position: { type: 'number', minimum: 0 },
                  name: { type: 'string', nullable: true },
                  page_reference: { type: 'string', nullable: true },
                  is_last_read: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { $ref: '#/components/schemas/Bookmark' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid position' },
          '404': { description: 'Guide not found' },
        },
      },
    },
    '/api/guides/{guideId}/bookmarks/{id}': {
      delete: {
        tags: ['Bookmarks'],
        summary: 'Delete bookmark',
        parameters: [
          { name: 'guideId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Guide or bookmark not found' },
        },
      },
    },
    '/api/guides/{guideId}/notes': {
      get: {
        tags: ['Notes'],
        summary: 'List notes for a guide',
        parameters: [{ name: 'guideId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Note' } },
                  },
                },
              },
            },
          },
          '404': { description: 'Guide not found' },
        },
      },
      post: {
        tags: ['Notes'],
        summary: 'Create note',
        parameters: [{ name: 'guideId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['content'],
                properties: {
                  position: { type: 'number', minimum: 0, nullable: true },
                  content: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { $ref: '#/components/schemas/Note' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid content or position' },
          '404': { description: 'Guide not found' },
        },
      },
    },
    '/api/guides/{guideId}/notes/{id}': {
      put: {
        tags: ['Notes'],
        summary: 'Update note',
        parameters: [
          { name: 'guideId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  position: { type: 'number', minimum: 0, nullable: true },
                  content: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { $ref: '#/components/schemas/Note' },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid content or position' },
          '404': { description: 'Guide or note not found' },
        },
      },
      delete: {
        tags: ['Notes'],
        summary: 'Delete note',
        parameters: [
          { name: 'guideId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Guide or note not found' },
        },
      },
    },
    '/api/games': {
      get: {
        tags: ['Games'],
        summary: 'List games',
        description: 'Paginated list.',
        parameters: [
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/games/with-guides': {
      get: {
        tags: ['Games'],
        summary: 'List games with guide counts',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/games/search': {
      get: {
        tags: ['Games'],
        summary: 'Search games by title',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Search query is required' },
        },
      },
    },
    '/api/games/{id}': {
      get: {
        tags: ['Games'],
        summary: 'Get game by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Game not found' },
        },
      },
    },
    '/api/games/{id}/guides': {
      get: {
        tags: ['Games'],
        summary: 'Get guides for a game',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Game not found' },
        },
      },
    },
    '/api/games/{id}/status': {
      put: {
        tags: ['Games'],
        summary: 'Update game status',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['status'],
                properties: {
                  status: { type: 'string', enum: ['in_progress', 'completed', 'not_started'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Invalid status' },
          '404': { description: 'Game not found' },
        },
      },
    },
    '/api/games/{id}/completion': {
      put: {
        tags: ['Games'],
        summary: 'Update completion percentage',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['percentage'],
                properties: { percentage: { type: 'number', minimum: 0, maximum: 100 } },
              },
            },
          },
        },
        responses: {
          '200': { description: 'OK' },
          '400': { description: 'Invalid percentage' },
          '404': { description: 'Game not found' },
        },
      },
    },
    '/api/admin/status': {
      get: {
        tags: ['Admin'],
        summary: 'Admin status',
        description: 'Detailed status. If ADMIN_TOKEN is set, use query param `?token=...` or Bearer header.',
        parameters: [{ name: 'token', in: 'query', schema: { type: 'string' }, description: 'Admin token (if required)' }],
        responses: {
          '200': { description: 'OK' },
          '401': { description: 'Unauthorized (token required)' },
        },
      },
    },
    '/api/admin/stats': {
      get: {
        tags: ['Admin'],
        summary: 'Admin stats',
        parameters: [{ name: 'token', in: 'query', schema: { type: 'string' } }],
        responses: {
          '200': { description: 'OK' },
          '401': { description: 'Unauthorized' },
        },
      },
    },
  },
  components: {
    schemas: {
      GuideSummary: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          format: { type: 'string', enum: ['txt', 'html', 'md', 'pdf'] },
          file_path: { type: 'string' },
          game_id: { type: 'string', nullable: true },
          metadata: { type: 'string', nullable: true },
          created_at: { type: 'number' },
          updated_at: { type: 'number' },
          content_length: { type: 'number' },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
      Bookmark: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          guide_id: { type: 'string' },
          position: { type: 'number' },
          name: { type: 'string', nullable: true },
          page_reference: { type: 'string', nullable: true },
          is_last_read: { type: 'boolean' },
          created_at: { type: 'number' },
        },
      },
      Note: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          guide_id: { type: 'string' },
          position: { type: 'number', nullable: true },
          content: { type: 'string' },
          created_at: { type: 'number' },
          updated_at: { type: 'number' },
        },
      },
    },
  },
} as const;
