const request = require('request');
const {mongoose} = require('./../db/mongoose');
const config = require('./../config/config');
const {Geo} = require('./../models/geo');
const {HospitalData} = require('./../models/hospitalData');
const googleApiBaseUrl = 'https://maps.googleapis.com/maps/api/';
const googleGeocodeBaseUrl = googleApiBaseUrl + 'geocode/json';
const googlePlacesBaseUrl = googleApiBaseUrl + 'place/nearbysearch/json';
const geonames = require('./geonames.js');
const arcgis = require('./arcgis.js');
const textutils = require('./../lib/text-utils.js');
const conversions = require('./../lib/conversions.js');
const querystring = require('querystring');

var geocode = {

	buildRequest: (data,typeStr = 'geocode') => {
		let href='',searchStr='',
      parts = typeStr.split('/'),
      type = parts.shift(),
      filter = '';
    if (parts.length>0) {
      filter = parts.pop();
    }	
    switch (type) {
      case 'hospital':
      case 'hospitals':
        if (data instanceof Array) {

          searchStr = data.join(',');
        } else {
          searchStr = data.toString();
        }
        var keywordStr = '';
        
        if (filter.length > 2) {
          keywordStr = `&keyword=${filter}`;
        }
        href = `${googlePlacesBaseUrl}?location=${searchStr}&type=hospital&query=maternity${keywordStr}&radius=5000`;

        break;
      default:
        searchStr = encodeURIComponent(data);
        href = `${googleGeocodeBaseUrl}?address=${searchStr}`;
        break;
    }
    href += `&key=${config.google.geocode_apikey}`;
		return {
		  url: href,
		  json: true,
		  rejectUnauthorized: false,
		  port: 443
		}
	},

  filterHospitals: (results) => {
    var data = {
        items: [],
        valid: false
      },
      numRes=results.length,
      i=0,res,item;
      for (;i<numRes;i++) {
        res = results[i];
        if (res.types) {
          if (res.types[0] == 'hospital') {
            item = {};
            item.id = res.id;
            item.name = res.name;
            item.coords = res.geometry.location;
            item.vicinity = res.vicinity;
            item.types = res.types.map(tp => tp.toString());
            data.items.push(item);
          }
        }
        
        
      }
      data.num_items = data.items.length;
      data.valid = data.num_items > 0;
      return data;
  },

  handlePlaceSearch: (body,callback) => {
    var results = body.results;
    if (results.length>0) {
      var data = geocode.filterHospitals(results);
      if (data.num_items > 0) {
        data.valid = true;
      }
      callback(undefined,data);
    }
  },

  handleLocationSearch: (body,callback,type) => {
    var result = body.results[0];
    if (result.geometry) {
      var numRes = body.results.length,other=[];
      if (numRes > 1) {
        body.results.shift()
        other = body.results;
      }
      /*if (result.address_components) {
        for (var i in result.address_components) {
          //
        }
      }*/
      var geo = result.geometry,
      data = {
        address: result.formatted_address,
        lat: geo.location.lat,
        lng: geo.location.lng,
        components: result.address_components[0],
        type: geo.location_type,
        other: other
      };

      if (data.type == 'APPROXIMATE') {
        type = 'full';
      }
      if (type == 'full') {
        var hFilter = '';
        geocode.mergeHospitals(data,hFilter,callback);
      } else {
        callback(undefined,data);
      }
    }
  },

  mergeHospitals: (data,hFilter,callback) => {
    let coords = data.lat + ',' + data.lng,
    modeStr = 'hospital';
    if (typeof hFilter == 'string') {
      modeStr += '/' + hFilter;
    }
    request(geocode.buildRequest(coords,modeStr), (error, response, body) => {
      if (error){
        callback({valid:false,message:error},undefined);
      } else {
        if (body.results) {
          data.hospitals = geocode.filterHospitals(body.results);
        }
        callback(undefined,data);
      }
    });
  },

  mergeGeonames: (nameStr,data,callback) => {
    data.geonames = {};
    data.has_geonames = false;
    let matchStr = data.lat+','+data.lng;
    geonames.request(nameStr, matchStr, 'filtered', (error, gData) => {
      if (error) {
        callback(data,undefined);
      } else {
        if (gData.items) {
          data.has_geonames = gData.num_items > 0;
          data.geonames = gData;
        }
        callback(undefined,data);
      }
    });
  },

	handleResponse: (type='geocode',error, body, callback) => {
		if (error) {
			callback('Unable to connect to Google servers' + JSON.stringify(error));
		} else if (body.status === 'ZERO_RESULTS') {
			callback('Unable to find a matching address');
		} else if (body.status === 'OK') {
		  if (body.results) {
		  	switch (type) {
          case 'hospital':
          case 'hospitals':
            geocode.handlePlaceSearch(body,callback);
            break;
          default:
            geocode.handleLocationSearch(body,callback,type);
            break;
        }
		  }
		  
		}
	},

	geocodeAddress: (data,type,callback) => {
		request(geocode.buildRequest(data,type), (error, response, body) => {
			geocode.handleResponse(type,error,body, callback);
		});
	},

  fetchHospitals: (searchString,res) => {
    geocode.geocodeAddress(searchString,'hospital', (errorMessage, result) => {
      if (errorMessage){
        res.status(404).send({valid:false,message:errorMessage});
      } else {
        var parts = searchString.split(','),
        coords = {
          lat: parseFloat(parts[0]),
          lng: parseFloat(parts[1])
        };
        var hd = new HospitalData({
            coords: coords,
            radius: 5000,
            items: result.items
          });
          hd.save().then((doc) => {
            var result = {};
            result.coords = doc.coords;
            result.radius = doc.radius;
            result.items = doc.items;
            result.num_items = doc.items.length;
            result.valid = true;
            result.stored = true;
            res.send(result);
          }, (e) => {
            res.status(404).send({valid:false,message:errorMessage});
          });
        }
    });
  },

  isPlacenameSearch: (str) => {
    let words = str.split(/[, ]/),
      numWords = words.length,
      strLen = str.length,i=0;
    if (numWords > 1 && strLen > 12) {
      for (;i<numWords;i++) {
        if (textutils.isHospitalWord(words[i])) {
          return true;
        }
      }
    }
    return false;
  },

  fetchData: (searchString,callback) => {
    if (geocode.isPlacenameSearch(searchString) === false) {
      geocode.fetchDataStandard(searchString,callback);
    } else {
      arcgis.match(searchString,(error, data) => {
        if (error){
          callback(error,undefined);
        } else {
          geocode.fetchLocation(conversions.coordsToStr(data.items[0].coords),(error,gData) => {
            if (error) {
              res.send(data);
            } else {
              gData.address = data.items[0].name + ', ' + gData.address;
              gData.valid = true;
              geocode.mergeData(gData.name,gData,(error,mData) => {
                if (error) {
                  callback(undefined,gData);
                } else {
                  callback(undefined,mData);
                }
              });
            }
          });
        }
      });
    }
    
  },

	fetchDataStandard: (searchString,callback) => {
		geocode.geocodeAddress(searchString,'geocode', (errorMessage, result) => {
      if (errorMessage){
			 return callback({valid:false,msg:errorMessage},undefined);
		  } else {
        var geo = new Geo({
          string: searchString.toLowerCase(),
          address: result.address,
          location: {
            lat: result.lat,
            lng: result.lng
          },
          location_type: result.type,
          address_components: result.components
        });
        geo.save().then((doc) => {
            //
        }, (e) => {
            console.log(e);
        })
  			result.valid = true;
        geocode.mergeData(searchString,result,(error,data) => {
          if (error) {
            callback(undefined,result);
          } else {
            callback(undefined,data);
          }
        });
  		}
  	});
  },

  mergeData: function(searchString,data,callback) {
    data.geomatched_index = -1;
    geocode.mergeGeonames(searchString,data,(error,gData) => {
      if (error) {
        res.send(data);
      } else {
        let hFilter = '';
        if (gData.has_geonames) {
          var matched = [];
          if (gData.geonames.items instanceof Array) {
            matched = gData.geonames.items.filter(item => item.matched);
          }
          if (matched.length>0) {
            data.geomatched_index = 0;
            if (matched[0].population > 30000) {
              switch (matched[0].countryCode) {
                case 'GB':
                case 'US':
                case 'CA':
                case 'AU':
                case 'IE':
                case 'NZ':
                  hFilter = 'maternity';
                  break;
              }
            }
          }
        }
        
        geocode.mergeHospitals(gData,hFilter,(error,hData) => {
          if (error) {
            callback(gData,undefined);
          } else {
            callback(undefined,hData);
          }
        });
      }
    });
  },

  fetchLocation: (searchString,callback) => {
    Geo.findOne({
      string: searchString.toLowerCase()
    }).then((doc) => {
      var matched = false;
      if (doc !== null) {
        var data = {};
        data.lat = doc.location.lat;
        data.lng = doc.location.lng;
        if (doc.address) {
          data.address = doc.address;
        } else {
          data.address = doc.string.capitalize();
        }
        data.type = doc.location_type;
        data.components = doc.address_components;
        matched = true;
        data.valid = true;
        geocode.mergeData(searchString,data,(error,mData) => {
          callback(undefined,mData);
        });
      }
      if (!matched) {
        geocode.fetchData(searchString, callback);
      }
    }).catch((e) => {
      callback({valid:false,msg:"application error"});
    });
  },

  matchLocation: (searchString, res) => {
    geocode.fetchLocation(searchString,(error,data) => {
      if (error) {
        res.status(404).send(error);
      } else {
        res.send(data);
      }
    })
  }
};


module.exports = geocode;