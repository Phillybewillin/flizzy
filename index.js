import 'dotenv/config';
import fastify from 'fastify';
import { META , MOVIES } from '@consumet/extensions';
import unidecode from 'unidecode';
import { fetchSources } from './src/flixhq/flixhq.js';
import cors from '@fastify/cors';

const app = fastify();

const tmdbApi = process.env.TMDB_KEY;
const port = process.env.PORT;

app.register(cors, { 
    origin: 'http://localhost:5173',
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

    if (!provider) {
        return reply.status(400).send({ message: "The 'provider' query is required" });
    }

    const fetchFlixhq = async (id, seasonNumber, episodeNumber) => {
        let tmdb = new META.TMDB(tmdbApi);
        const flixhq = new MOVIES.FlixHQ();
        let type = seasonNumber && episodeNumber ? 'show' : 'movie';
        console.log(` 1 Fetching media info for ID: ${id} and type: ${type}`);
         
        try {
            console.log(` 2 Fetching media info for ID: ${id} and type: ${type}`);
            const res = await tmdb.fetchMediaInfo(id, type);

            //console.log(res)
            const resAbdolute = unidecode(res.title)
            const flixhqResults = await flixhq.search(unidecode(resAbdolute));
             console.log('flixhqResults:', flixhqResults);
            
            const flixhqItem = flixhqResults.results.find(item => {
                if (item.releaseDate !== undefined) {
                  const year = res.releaseDate.substring(0, 4);
                console.log('item.releaseDate:', item.releaseDate, 'year:', year, 'title:', item.title, 'res.title:', res.title , 'type:', item.type, 'res.type:', res.type, 'seasons:', item.seasons, 'res.totalSeasons:', res.totalSeasons);
                  if(item.type === 'TV Series'){
                    console.log('type: TV Series true' , res.totalSeasons, item.seasons);
                      return item.releaseDate === year && item.title === res.title ;
                  }
                  return item.releaseDate === year && item.title === res.title && item.type === res.type;
                  
                }
                if(item.releaseDate === undefined){
                    console.log('release date undefined')
                    if(item.type === 'TV Series'){
                    console.log('type 2: TV Series true' , res.totalSeasons, item.seasons);
                          return item.title === res.title && item.seasons === res.totalSeasons;
                    }
                    return item.title === res.title && item.type === res.type;
                  }
              
                //console.log('fallback');
              
                // If item.releaseDate is undefined, fallback to comparing title and type
                return item.title === res.title && item.type === res.type;
              });
            if (!flixhqItem) {
                console.log('No matching movie found on FlixHQ.' , item.title , item.type ,'res.title:', res.title , 'res.type:', res.type );
                return reply.status(404).send({ message: 'Matching movie not found on FlixHQ.' });
            }
    
            const mid = flixhqItem.id ; // Full ID, e.g., 'movie/watch-fly-me-to-the-moon-111118'
           // const episodeId = mid.split('-').pop(); // Extracted number, e.g., '111118'
            const flixMedia = await flixhq.fetchMediaInfo(mid)

           console.log('flix media info ', flixMedia , 'mid:', mid);
          
            let episodeId;

            if (mid.startsWith('movie/')) {
                //const parts = mid.split('-');
                episodeId = mid.split('-').pop();; 
                } else if (mid.startsWith('tv/') && seasonNumber && episodeNumber) {

                    const episodex = flixMedia.episodes.find(episode => episode.number === episodeNumber && episode.season === seasonNumber);

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
    
    if (provider === 'flixhq') {
        await fetchFlixhq(id, seasonNumber, episodeNumber);
    }
    else {
        return reply.status(400).send({ message: 'Invalid provider specified' });
    }
});

const start = async () => {
    try {
        app.listen({ port: port });
        console.log(`AIO Streamer is listening on port http://localhost:${port}`);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();
