import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import GraphQLUpdate from '../object/Update';

const UpdateCollection = new GraphQLObjectType({
  name: 'UpdateCollection',
  interfaces: [Collection],
  description: 'A collection of "Updates"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLUpdate),
      },
    };
  },
});

export { UpdateCollection };
