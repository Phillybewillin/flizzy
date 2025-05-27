import 'dotenv/config';
import fastify from 'fastify';
import { META, MOVIES } from '@consumet/extensions';
import unidecode from 'unidecode';
import cors from '@fastify/cors';

const app = fastify({ logger: true }); // Enable Fastify logger
const tmdbApi = process.env.TMDB_KEY;

// Define provider configurations from @consumet/extensions
// Ensure these provider classes exist and are correctly named in your MOVIES import
const PROVIDER_CLASSES = {
    flixhq: MOVIES.FlixHQ,
    dramacool: MOVIES.DramaCool,
    fmovies: MOVIES.Fmovies,
    goku: MOVIES.Goku,
    kissasian: MOVIES.KissAsian,
    moviehdwatch: MOVIES.MovieHdWatch,
    viewasian: MOVIES.ViewAsian,
    sflix: MOVIES.SFlix,
    multimovies: MOVIES.MultiMovies,     // Verify existence and standard interface in @consumet/extensions
    netflixmirror: MOVIES.NetflixMirror, // Verify existence and standard interface in @consumet/extensions
};

// Ordered list of provider keys for failover
// Adjust this order based on provider preference and reliability
const DEFAULT_PROVIDER_ORDER = [
    'flixhq',        // Try FlixHQ first by default
    'sflix',
    'goku',
    'fmovies',
    'moviehdwatch',
    // Add other providers in your preferred fallback order
    'dramacool',
    'kissasian',
    'viewasian',
    'multimovies',
    'netflixmirror',
].filter(key => PROVIDER_CLASSES[key]); // Ensure only available providers are in the order

app.register(cors, {
    origin: ['https://zilla-xr.xyz', 'http://localhost:5173', ...(process.env.NODE_ENV === 'development' ? ['http://127.0.0.1:5173'] : [])],
    methods: ['GET', 'POST']
});

app.get('/', async (request, reply) => {
    return {
        intro: "Welcome to the unofficial multi-provider resolver with failover.",
        documentation: "API documentation: https://github.com/Inside4ndroid/AIO-StreamSource (original base)",
        author: "Original by Inside4ndroid, modified for enhanced failover."
    };
});

// Helper function to calculate match score between TMDB info and provider search result
function calculateScore(providerItem, tmdbInfo, request) {
    let score = 0;
    if (!providerItem || !tmdbInfo) return 0;

    const normalizeTitle = (title) => unidecode(title.toLowerCase().replace(/[^\w\s]/gi, '')); // Normalize by removing special chars too

    // Title match (crucial)
    if (providerItem.title && tmdbInfo.title) {
        const normProviderTitle = normalizeTitle(providerItem.title);
        const normTmdbTitle = normalizeTitle(tmdbInfo.title);
        if (normProviderTitle === normTmdbTitle) {
            score += 30; // Strong match
        } else if (normProviderTitle.includes(normTmdbTitle) || normTmdbTitle.includes(normProviderTitle)) {
            score += 15; // Partial match
        }
    }

    // Type match
    const normalizeType = (typeStr) => {
        if (!typeStr) return undefined;
        const lowerType = typeStr.toLowerCase();
        if (lowerType.includes('movie')) return 'movie';
        if (lowerType.includes('tv') || lowerType.includes('show') || lowerType.includes('series')) return 'show';
        return undefined;
    };
    
    const providerType = normalizeType(providerItem.type);
    const tmdbType = tmdbInfo.type; // Should be 'movie' or 'show'

    if (providerType && tmdbType && providerType === tmdbType) {
        score += 10;
    }

    // Release year match
    const providerYear = String(providerItem.year || providerItem.releaseDate).substring(0, 4);
    const tmdbYear = String(tmdbInfo.releaseDate).substring(0, 4);
    if (providerYear && tmdbYear && providerYear === tmdbYear) {
        score += 10;
    }
    
    // Season count for TV shows
    if (tmdbType === 'show' && providerItem.seasons && tmdbInfo.totalSeasons && providerItem.seasons === tmdbInfo.totalSeasons) {
        score += 5;
    }

    if (request && request.log) { // Check if request.log is available
        request.log.info(`Score for "${providerItem.title}" (Provider) vs "${tmdbInfo.title}" (TMDB): ${score}. ProviderType: ${providerType}, TMDBType: ${tmdbType}. ProviderYear: ${providerYear}, TMDBYear: ${tmdbYear}.`);
    }
    return score;
}

// Fetches sources from a single specified provider
async function fetchSourcesFromSingleProvider(providerKey, providerInstance, tmdbMediaInfo, seasonNumber, episodeNumber, request) {
    const providerName = providerKey.toUpperCase();
    request.log.info(`[${providerName}] Attempting to fetch sources...`);
    try {
        const searchTitle = unidecode(tmdbMediaInfo.title);
        // Some providers might take a second argument (e.g., isTvShow) for search.
        // Consumet aims for standardization, but this can vary.
        // Defaulting to just title. Add `tmdbMediaInfo.type === 'show'` if needed for specific providers.
        const searchResults = await providerInstance.search(searchTitle);

        if (!searchResults || !searchResults.results || searchResults.results.length === 0) {
            request.log.warn(`[${providerName}] No search results for "${searchTitle}".`);
            return null;
        }
        
        let bestMatch = { item: null, score: -1 };
        for (const item of searchResults.results) {
            if (!item.title) continue;
            const currentScore = calculateScore(item, tmdbMediaInfo, request);
            if (currentScore > bestMatch.score) {
                bestMatch = { item, score: currentScore };
            }
        }

        const MINIMUM_SCORE_THRESHOLD = 20; // Adjusted threshold: title + year or type should match
        if (!bestMatch.item || bestMatch.score < MINIMUM_SCORE_THRESHOLD) {
            request.log.warn(`[${providerName}] No sufficiently matching media found for "${tmdbMediaInfo.title}". Best: "${bestMatch.item?.title}" (Score: ${bestMatch.score}). Minimum needed: ${MINIMUM_SCORE_THRESHOLD}`);
            return null;
        }

        const providerMediaId = bestMatch.item.id;
        request.log.info(`[${providerName}] Best match: "${bestMatch.item.title}" (ID: ${providerMediaId}, Score: ${bestMatch.score}). Fetching media info...`);

        const providerMediaInfo = await providerInstance.fetchMediaInfo(providerMediaId);

        if (!providerMediaInfo || !providerMediaInfo.id) { // providerMediaInfo.id is crucial
            request.log.warn(`[${providerName}] Could not fetch media info for ID ${providerMediaId}.`);
            return null;
        }
        
        let episodeIdToFetch;
        // The mediaId for fetchEpisodeSources is usually providerMediaInfo.id (the ID returned by fetchMediaInfo)
        const mediaIdForSources = providerMediaInfo.id; 

        if (tmdbMediaInfo.type === 'movie') {
            episodeIdToFetch = providerMediaInfo.episodeId || 
                               (providerMediaInfo.episodes && providerMediaInfo.episodes.length > 0 ? providerMediaInfo.episodes[0].id : null);
            if (!episodeIdToFetch) {
                 // For movies, the episodeId is often the same as the mediaId itself if not explicitly provided
                 episodeIdToFetch = mediaIdForSources; 
            }
        } else if (tmdbMediaInfo.type === 'show' && seasonNumber !== undefined && episodeNumber !== undefined) {
            if (!providerMediaInfo.episodes || providerMediaInfo.episodes.length === 0) {
                request.log.warn(`[${providerName}] No episodes listed for TV show "${providerMediaInfo.title}".`);
                return null;
            }
            const targetEpisode = providerMediaInfo.episodes.find(
                ep => ep.season === seasonNumber && ep.number === episodeNumber
            );

            if (!targetEpisode) {
                request.log.warn(`[${providerName}] Episode S${seasonNumber}E${episodeNumber} not found for "${providerMediaInfo.title}".`);
                return null;
            }
            episodeIdToFetch = targetEpisode.id;
        } else {
            request.log.error(`[${providerName}] Invalid TMDB type or missing season/episode numbers.`);
            return null; 
        }

        if (!episodeIdToFetch) {
            request.log.warn(`[${providerName}] Could not determine episode ID to fetch for "${tmdbMediaInfo.title}".`);
            return null;
        }
        
        request.log.info(`[${providerName}] Fetching sources for Media ID: ${mediaIdForSources}, Episode ID: ${episodeIdToFetch}`);
        const sources = await providerInstance.fetchEpisodeSources(episodeIdToFetch, mediaIdForSources);

        if (sources && sources.sources && sources.sources.length > 0) {
            request.log.info(`[${providerName}] Successfully fetched ${sources.sources.length} sources.`);
            return sources;
        } else {
            request.log.warn(`[${providerName}] No sources returned for Episode ID ${episodeIdToFetch} (Media ID ${mediaIdForSources}).`);
            return null;
        }

    } catch (error) {
        request.log.error(`[${providerName}] Error: ${error.message}`, error.stack);
        return null; // Indicate failure, allow main loop to try next provider
    }
}

app.get('/vidsrc', async (request, reply) => {
    const tmdbId = request.query.id;
    const seasonNumber = request.query.s ? parseInt(request.query.s, 10) : undefined;
    const episodeNumber = request.query.e ? parseInt(request.query.e, 10) : undefined;
    const preferredProviderKey = request.query.provider?.toLowerCase();

    if (!tmdbId) {
        return reply.status(400).send({ message: "The 'id' (TMDB ID) query parameter is required." });
    }

    let tmdbMediaInfo;
    const tmdb = new META.TMDB(tmdbApi);
    const type = (seasonNumber !== undefined && episodeNumber !== undefined) ? 'show' : 'movie';

    try {
        request.log.info(`Workspaceing TMDB media info for ID: ${tmdbId}, type: ${type}`);
        const rawTmdbInfo = await tmdb.fetchMediaInfo(tmdbId, type); // Pass type to TMDB
        if (!rawTmdbInfo || !rawTmdbInfo.title) {
            request.log.error(`TMDB ID ${tmdbId} (type: ${type}) not found or info incomplete.`);
            return reply.status(404).send({ message: `Media with TMDB ID ${tmdbId} (type: ${type}) not found or TMDB API error.` });
        }
        tmdbMediaInfo = rawTmdbInfo;
        tmdbMediaInfo.type = type; // Ensure our 'movie'/'show' type is set
        request.log.info(`TMDB Info for "${tmdbMediaInfo.title}": Type=${tmdbMediaInfo.type}, Release=${tmdbMediaInfo.releaseDate}, Total Seasons=${tmdbMediaInfo.totalSeasons || 'N/A'}`);
    } catch (error) {
        request.log.error(`Failed to fetch TMDB media info for ID ${tmdbId}: ${error.message}`);
        return reply.status(500).send({ message: 'Failed to fetch media information from TMDB.' });
    }

    let providersToAttempt = [...DEFAULT_PROVIDER_ORDER];
    if (preferredProviderKey) {
        if (!PROVIDER_CLASSES[preferredProviderKey]) {
            return reply.status(400).send({ message: `Provider '${preferredProviderKey}' is not supported. Supported: ${Object.keys(PROVIDER_CLASSES).join(', ')}` });
        }
        // Move preferred provider to the front, ensuring it's only tried once if also in default list.
        providersToAttempt = [preferredProviderKey, ...providersToAttempt.filter(pKey => pKey !== preferredProviderKey)];
    }
    
    request.log.info(`Attempting providers in order: ${providersToAttempt.join(' -> ')} for TMDB ID ${tmdbId} ("${tmdbMediaInfo.title}")`);

    for (const providerKey of providersToAttempt) {
        const ProviderClass = PROVIDER_CLASSES[providerKey];
        // ProviderClass should already be filtered by DEFAULT_PROVIDER_ORDER definition, but double check for preferredProviderKey.
        if (!ProviderClass) { 
            request.log.warn(`Skipping unknown provider key in attempt list: ${providerKey}`);
            continue;
        }

        const providerInstance = new ProviderClass(); // Assumes no-arg constructor
        
        const sources = await fetchSourcesFromSingleProvider(
            providerKey,
            providerInstance,
            tmdbMediaInfo,
            seasonNumber,
            episodeNumber,
            request // Pass request for logging capabilities
        );

        if (sources) {
            request.log.info(`Sources found successfully via ${providerKey.toUpperCase()} for "${tmdbMediaInfo.title}".`);
            return reply.status(200).send({
                message: `Sources retrieved from ${providerKey.toUpperCase()}`,
                provider: providerKey,
                tmdbInfo: { id: tmdbId, title: tmdbMediaInfo.title, type: tmdbMediaInfo.type },
                data: sources
            });
        } else {
            request.log.info(`Provider ${providerKey.toUpperCase()} did not yield sources. Attempting next provider...`);
        }
    }

    request.log.warn(`All (${providersToAttempt.length}) configured providers attempted for "${tmdbMediaInfo.title}" (TMDB ID ${tmdbId}), but no sources were found.`);
    return reply.status(404).send({ message: 'No sources found from any available provider after thorough search.' });
});

const start = async () => {
    try {
        const port = parseInt(process.env.PORT || "3001", 10);
        await app.listen({ port: port, host: '0.0.0.0' });
        app.log.info(`AIO Streamer with failover is listening on port ${port}, host 0.0.0.0`);
        app.log.info(`Default provider order: ${DEFAULT_PROVIDER_ORDER.join(' -> ')}`);
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};

start();
