import 'dotenv/config';
import fastify from 'fastify';
import { META , MOVIES  } from '@consumet/extensions';
import unidecode from 'unidecode';
import { getEPORN_CATEGORIES } from './src/eporner/Categories.js';
import { getVideoSources } from './src/eporner/Resolver.js';
import { getSearchResults } from './src/eporner/Search.js';
import { getVideoDetails } from './src/eporner/MediaDetails.js';
import { fetchSources } from './src/flixhq/flixhq.js';
import { getmovie, getserie } from './src/vidsrc/vidsrcto.js';
import { VidSrcExtractor, VidSrcExtractor2  } from './src/vidsrcme/vidsrcme.js';
import cors from '@fastify/cors';

const app = fastify();



const tmdbApi = process.env.TMDB_KEY;
const port = process.env.PORT;

app.register(cors, { 
    origin: 'https://zilla-xr.xyz',
    methods: ['GET', 'POST'],
  })

app.get('/', async (request, reply) => {
    return {
        intro: "Welcome to the unofficial multi provider resolver and eporner api currently the ONLY All-In-One solution aswell as additional Eporner resolver.",
        documentation: "Please see github repo : https://github.com/Inside4ndroid/AIO-StreamSource",
        author: "This api is developed and created by Inside4ndroid"
    };
});

app.get('/vidsrc', async (request, reply) => {
    const id = request.query.id;
    const seasonNumber = parseInt(request.query.s, 10);
    const episodeNumber = parseInt(request.query.e, 10);
    const provider = request.query.provider;
    const thumbsize = request.query.thumbsize || 'medium';
    const resolve = request.query.resolve;
    const search = request.query.search;
    const per_page = request.query.per_page || '30';
    const page = request.query.page || '1';
    const order = request.query.order || 'latest';
    const gay = request.query.gay || '0';
    const lq = request.query.gay || '1';
    const cats = request.query.cats || null;
    const type = request.query.type || null;

    if (!provider) {
        return reply.status(400).send({ message: "The 'provider' query is required" });
    }

  const fetchFlixhq = async (id, seasonNumber, episodeNumber) => {
        let tmdb = new META.TMDB(tmdbApi);
        const flixhq = new MOVIES.FlixHQ();
        let type = seasonNumber && episodeNumber ? 'show' : 'movie';
    
        try {
            //console.log(`Fetching media info for ID: ${id} and type: ${type}`);
            const res = await tmdb.fetchMediaInfo(id, type);

             //console.log(res)
            const resAbdolute = unidecode(res.title)
            const flixhqResults = await flixhq.search(unidecode(resAbdolute));
             //console.log('flixhqResults:', flixhqResults);
            
            const flixhqItem = flixhqResults.results.find(item => {
                if (item.releaseDate !== undefined) {
                  const year = res.releaseDate.substring(0, 4);
                  //console.log('item.releaseDate:', item.releaseDate, 'year:', year, 'title:', item.title, 'res.title:', res.title , 'type:', item.type, 'res.type:', res.type, 'seasons:', item.seasons, 'res.totalSeasons:', res.totalSeasons);
                  if(item.type === 'TV Series'){
                   // console.log('type: TV Series true' , res.totalSeasons, item.seasons);
                      return item.releaseDate === year && item.title === res.title && item.seasons === res.totalSeasons;
                  }
                  return item.releaseDate === year && item.title === res.title && item.type === res.type;
                  
                }
                if(item.releaseDate === undefined){
                    //console.log('release date undefined')
                    if(item.type === 'TV Series'){
                        //console.log('type 2: TV Series true' , res.totalSeasons, item.seasons);
                          return item.title === res.title && item.seasons === res.totalSeasons;
                    }
                    return item.title === res.title && item.type === res.type && item.seasons === res.totalSeasons;
                  }
              
                //console.log('fallback');
              
                // If item.releaseDate is undefined, fallback to comparing title and type
                return item.title === res.title && item.type === res.type;
              });
            if (!flixhqItem) {
                console.log('No matching movie found on FlixHQ.');
                return reply.status(404).send({ message: 'Matching movie not found on FlixHQ.' });
            }
    
            const mid = flixhqItem.id ; // Full ID, e.g., 'movie/watch-fly-me-to-the-moon-111118'
           // const episodeId = mid.split('-').pop(); // Extracted number, e.g., '111118'
            const flixMedia = await flixhq.fetchMediaInfo(mid)
           // console.log('flix media info ', flixMedia);
          
            let episodeId;

            if (mid.startsWith('movie/')) {
                //const parts = mid.split('-');
                episodeId =mid.split('-').pop();; 
                } else if (mid.startsWith('tv/') && seasonNumber && episodeNumber) {
                    const episodex = flixMedia.episodes.find(episode => episode.number === episodeNumber);

                    if (!episodex) {
                        console.log('Episode not found.' );
                        return reply.status(404).send({ message: 'Episode not found' });
                    }

                    episodeId = episodex.id;
              
              }
            console.log('Selected MID:', mid ,'Selected Episode ID:', episodeId);

            const res1 = await fetchSources(episodeId, mid).catch((err) => {
                //console.log('res1:', episodeId, mid);
                return reply.status(404).send({ message: err });
            });
    
            if (res1 && res) {
                return reply.status(200).send({ data: res1 });
            } else {
                return reply.status(404).send({ message: 'Sources not found.' });
            }
        } catch (error) {
            //console.error('TMDB class version:', tmdb.version);
            return reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
        }
    };
    const fetchVidsrc = async (id, seasonNumber, episodeNumber) => {
        let type;

        if (seasonNumber && episodeNumber) {
            type = 'show';
        } else {
            type = 'movie';
        }
        try {
            const res = await new META.TMDB(tmdbApi).fetchMediaInfo(id, type);
            if (seasonNumber && episodeNumber) {
                const response = await getserie(id, seasonNumber, episodeNumber);
                if (!response) {
                    return reply.status(404).send({ status: 404, return: "Sources not found." });
                } else {
                    const data = {
                        res
                    };
                    return reply.status(200).send([data, response]);
                }
            } else {
                const response = await getmovie(id);
                if (!response) {
                    return reply.status(404).send({ status: 404, return: "Sources not found." });
                } else {
                    const data = {
                        res
                    };
                    return reply.status(200).send([data, response]);
                }
            }
        } catch (error) {
            return reply.status(500).send({ message: 'Something went wrong. Contact developer for help.' });
        }
    };

    const fetchVidsrcMe = async (id, type) => {

        if (!type) {
            return reply.status(400).send({ message: "The 'type' query is required" });
        }

        const extractor = new VidSrcExtractor();
        const url = `https://vidsrc.net/embed/movie?tmdb=${id}`;
        const referer = null;
    
        try {
            const sources = [];
            const subtitles = [];
            const res = await new META.TMDB(tmdbApi).fetchMediaInfo(id, type);

            const subtitleCallback = (subtitleFile) => {
                console.log('Subtitle:', subtitleFile);
            };
    
            const linkCallback = (extractorLink) => {
                console.log('Extractor Link:', extractorLink);
                const data1 = {
                    res
                };
                sources.push({
                    url: extractorLink.url,
                    quality: extractorLink.quality,
                    isM3U8: extractorLink.isM3u8
                });

                const response = {
                    data: {
                        headers: {
                            Referer: extractorLink.referer
                        },
                        sources: sources,
                        subtitles: subtitles
                    }
                };
                return reply.status(200).send([data1, response]);
            };
    
            await extractor.getUrl(url, referer, subtitleCallback, linkCallback);
        } catch (error) {
            console.error('Error extracting URL:', error);
            reply.status(500).send('Internal Server Error');
        }
    };


    const fetchEporner = async (id, thumbsize, resolve, search, per_page, page, order, gay, lq) => {
        if (id) {
            const getDetails = await getVideoDetails(id, thumbsize);
            if (getDetails === null) {
                reply.status(404).send({
                    status: 404,
                    return: "Oops reached rate limit of this api"
                });
            } else {
                return reply.status(200).send(
                    [getDetails]
                )
            }
        }

        if (resolve) {
            const getSources = await getVideoSources(resolve);
            if (getSources === null) {
                reply.status(404).send({
                    status: 404,
                    return: "Oops reached rate limit of this api"
                });
            } else {
                return reply.status(200).send(
                    [getSources]
                )
            }
        }

        if (search) {
            const getResults = await getSearchResults(search, per_page, page, thumbsize, order, gay, lq);
            if (getResults === null) {
                reply.status(404).send({
                    status: 404,
                    return: "Oops reached rate limit of this api"
                });
            } else {
                return reply.status(200).send(
                    [getResults]
                )
            }
        }
    };

    const fetchEpornerCats = async () => {
        const getCats = await getEPORN_CATEGORIES();
        if (getCats === null) {
            reply.status(404).send({
                status: 404,
                return: "Oops reached rate limit of this api"
            });
        } else {
            console.log(getCats);
            return reply.status(200).send(
                getCats
            )
        }
    }

    if (provider === 'flixhq') {
        await fetchFlixhq(id, seasonNumber, episodeNumber);
    } else if (provider === 'vidsrc') {
        await fetchVidsrc(id, seasonNumber, episodeNumber);
    } else if (provider === 'vidsrcme') {
        await fetchVidsrcMe(id, type);
    } else if (provider === 'eporner') {
        if (cats) {
            await fetchEpornerCats();
        } else {
            await fetchEporner(id, thumbsize, resolve, search, per_page, page, order, gay, lq);
        }
    }
    else {
        return reply.status(400).send({ message: 'Invalid provider specified' });
    }
});

const start = async () => {
    try {
        const port = process.env.PORT || 3000;  // Use Render's provided port or fallback to 3000
        await app.listen({ port: port, host: '0.0.0.0' }); // Bind to 0.0.0.0 to listen on all interfaces
        console.log(`AIO Streamer is listening on port http://localhost:${port}`);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};


start();
